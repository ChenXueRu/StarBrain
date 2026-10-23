import { lazy, Suspense, useEffect, useState } from 'react'
import { getSettings, listGroups, listStars } from '../api'
import type { Group, Star } from '../api'
import { SceneBoundary } from '../universe/SceneBoundary'
import { webglAvailable } from '../universe/webgl'
import { readLevelNames } from '../starUtils'
import { StarList } from './StarList'

export type UniverseView = 'universe' | 'list'

// three.js 很大，等到真的要畫 3D 才下載
const UniverseScene = lazy(() => import('../universe/UniverseScene'))

type Data = { stars: Star[]; groups: Group[]; levelNames: string[] }

export function Universe({ refreshKey, view, onOpenStar }: { refreshKey: number; view: UniverseView; onOpenStar: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let ignore = false
    Promise.all([listStars(), listGroups(), getSettings()])
      .then(([stars, groups, settings]) => {
        if (ignore) return
        setData({ stars, groups, levelNames: readLevelNames(settings) })
        setFailed(false)
      })
      .catch(() => !ignore && setFailed(true))
    return () => {
      ignore = true
    }
  }, [refreshKey])

  const empty = data !== null && data.stars.length === 0
  const list = data && !empty ? <StarList stars={data.stars} onOpenStar={onOpenStar} /> : null

  return (
    <main className="universe">
      {data === null ? (
        failed && <p className="universe__empty">無法載入星星</p>
      ) : view === 'universe' && webglAvailable() ? (
        <SceneBoundary fallback={list}>
          <Suspense fallback={null}>
            <UniverseScene stars={data.stars} groups={data.groups} levelNames={data.levelNames} onOpenStar={onOpenStar} />
          </Suspense>
        </SceneBoundary>
      ) : (
        list
      )}
      {empty && <p className="universe__empty">你的宇宙還沒有星星</p>}
    </main>
  )
}
