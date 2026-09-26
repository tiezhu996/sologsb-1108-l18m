import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import type { DevRun } from '../types/dev-run'

type NewRun = Omit<DevRun, 'id' | 'schemaRev'>

export interface RunSaveResult {
  id: number
  developerName?: string
  developerExceeded: boolean
}

export class FilmShortageError extends Error {
  filmLabel: string
  rollCount: number
  rollsLeft: number
  shortage: number

  constructor(filmLabel: string, rollCount: number, rollsLeft: number) {
    super(`${filmLabel} 余量不足：本次需 ${rollCount} 卷，库存仅剩 ${rollsLeft} 卷，还差 ${rollCount - rollsLeft} 卷，已挡下本次登记`)
    this.name = 'FilmShortageError'
    this.filmLabel = filmLabel
    this.rollCount = rollCount
    this.rollsLeft = rollsLeft
    this.shortage = rollCount - rollsLeft
  }
}

export const useRunStore = defineStore('run', {
  state: () => ({
    runs: [] as DevRun[],
    loading: false
  }),
  getters: {
    recentRuns: (state) => [...state.runs]
      .sort((a, b) => b.runDate.localeCompare(a.runDate))
      .slice(0, 6)
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.runs = await db.runs.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },
    async addRun(payload: NewRun): Promise<RunSaveResult> {
      const rollCount = Math.max(1, Math.floor(payload.rollCount))
      const film = await db.films.get(payload.filmId)
      if (!film || film.id === undefined) {
        throw new Error('所选胶片批次不存在，请重新选择胶片批次')
      }
      // 胶片余量不够时整笔登记挡下，绝不扣成负数
      if (film.rollsLeft < rollCount) {
        const filmLabel = `${film.model} · ${film.format} · ${film.emulsionNo}`
        throw new FilmShortageError(filmLabel, rollCount, film.rollsLeft)
      }

      const next = { ...payload, rollCount, schemaRev: 3 }
      const id = await db.runs.add(plain(next))
      await db.films.update(film.id, plain({ rollsLeft: film.rollsLeft - rollCount }))

      let developerName: string | undefined
      let developerExceeded = false
      const recipe = await db.recipes.get(payload.recipeId)
      if (recipe) {
        const developer = await db.developers.get(recipe.developerId)
        if (developer && developer.id !== undefined && developer.state !== '报废') {
          // 显影液按本次卷数累计；超过标称上限仍照常保存，只在结果里提示评估报废
          const usedRolls = developer.usedRolls + rollCount
          developerExceeded = usedRolls > developer.maxRolls
          developerName = developer.name
          await db.developers.update(developer.id, plain({ usedRolls }))
        }
      }
      await this.load()
      return { id, developerName, developerExceeded }
    },
    async writeBackNote(runId: number, recipeId: number): Promise<void> {
      const run = await db.runs.get(runId)
      if (!run) return
      const note = `${run.runDate} 实冲 ${run.actualTempC}°C / ${run.actualMinutes} 分钟：${run.result}`
      await db.recipes.update(recipeId, plain({ note }))
    }
  }
})
