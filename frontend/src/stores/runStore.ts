import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import type { DevRun } from '../types/dev-run'

type NewRun = Omit<DevRun, 'id' | 'schemaRev'>

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
    async addRun(payload: NewRun): Promise<number> {
      const rollCount = Math.floor(payload.rollCount)
      if (!Number.isFinite(rollCount) || rollCount < 1) {
        throw new Error('本次卷数至少为 1 卷，本次登记未保存')
      }
      const film = await db.films.get(payload.filmId)
      if (!film || film.id === undefined) {
        throw new Error('未找到所选胶片批次，本次登记未保存')
      }
      if (film.rollsLeft < rollCount) {
        const shortage = rollCount - film.rollsLeft
        throw new Error(`胶片余量不足：${film.model} · ${film.emulsionNo} 仅剩 ${film.rollsLeft} 卷，本次需 ${rollCount} 卷，还差 ${shortage} 卷，本次登记未保存`)
      }
      const next = { ...payload, rollCount, schemaRev: 3 }
      const id = await db.runs.add(plain(next))
      const recipe = await db.recipes.get(payload.recipeId)
      if (recipe) {
        const developer = await db.developers.get(recipe.developerId)
        if (developer && developer.id !== undefined && developer.state !== '报废') {
          await db.developers.update(developer.id, plain({ usedRolls: developer.usedRolls + rollCount }))
        }
      }
      await db.films.update(film.id, plain({ rollsLeft: film.rollsLeft - rollCount }))
      await this.load()
      return id
    },
    async writeBackNote(runId: number, recipeId: number): Promise<void> {
      const run = await db.runs.get(runId)
      if (!run) return
      const note = `${run.runDate} 实冲 ${run.actualTempC}°C / ${run.actualMinutes} 分钟：${run.result}`
      await db.recipes.update(recipeId, plain({ note }))
    }
  }
})
