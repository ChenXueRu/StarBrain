import { getStar } from './api'
import type { Group, Star, StarDetail } from './api'

// 星體面板要立刻有東西可看：宇宙載入時就把星體與星系清單記下來（主題、等級、次數都在裡面，只差紀錄），
// 點下去的瞬間（pointerdown，早於 click）就先開始抓星體的完整資料，面板開啟時直接接手，不必從頭等一趟網路。

const DETAIL_TTL = 15_000 // 預先抓的資料只在這麼久內有效，太舊就重抓，才不會看到過期的紀錄

let knownStars = new Map<string, Star>()
let knownGroups: Group[] = []
const pending = new Map<string, { at: number; promise: Promise<StarDetail> }>()

export function rememberUniverse(stars: Star[], groups: Group[]) {
  knownStars = new Map(stars.map((star) => [star.id, star]))
  knownGroups = groups
}

export const knownStar = (id: string): Star | undefined => knownStars.get(id)
export const knownGroupList = (): Group[] => knownGroups

// 開始抓（同一顆星重複呼叫只會有一次請求）；失敗就丟掉，面板自己會再抓
export function prefetchStar(id: string, now = Date.now()) {
  const hit = pending.get(id)
  if (hit && now - hit.at < DETAIL_TTL) return
  const promise = getStar(id)
  pending.set(id, { at: now, promise })
  promise.catch(() => {
    if (pending.get(id)?.promise === promise) pending.delete(id)
  })
}

// 面板第一次載入用：有預先抓的就接手（只能接手一次），沒有就現抓
export function takeStarDetail(id: string, now = Date.now()): Promise<StarDetail> {
  const hit = pending.get(id)
  pending.delete(id)
  return hit && now - hit.at < DETAIL_TTL ? hit.promise : getStar(id)
}
