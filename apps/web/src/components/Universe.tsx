import { lazy, memo, Suspense, useCallback, useEffect, useState } from 'react'
import { listGroups, listStars } from '../api'
import type { Group, Star } from '../api'
import { rememberUniverse } from '../starCache'
import { SceneBoundary } from '../universe/SceneBoundary'
import { StructureTree } from '../universe/StructureTree'
import { webglAvailable } from '../universe/webgl'
import { StarList } from './StarList'

// three.js 很大，等到真的要畫 3D 才下載
const UniverseScene = lazy(() => import('../universe/UniverseScene'))

type Data = { stars: Star[]; groups: Group[] }

type Props = {
  refreshKey: number
  onOpenStar: (id: string) => void
  structureOpen: boolean
  onStructureOpenChange: (open: boolean) => void
  // 有面板蓋住宇宙時為 true：窄螢幕上 3D 場景可以先停下來省電、讓出效能
  covered: boolean
}

// memo：開關面板時 App 會重繪，宇宙本身不必跟著重繪（星星很多時一次重繪不便宜）
export const Universe = memo(function Universe({ refreshKey, onOpenStar, structureOpen, onStructureOpenChange, covered }: Props) {
  const [data, setData] = useState<Data | null>(null)
  const [failed, setFailed] = useState(false)
  // 在 3D 宇宙的結構面板改動群組或星體後，用它重新載入資料
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    let ignore = false
    Promise.all([listStars(), listGroups()])
      .then(([stars, groups]) => {
        if (ignore) return
        rememberUniverse(stars, groups)
        setData({ stars, groups })
        setFailed(false)
      })
      .catch(() => !ignore && setFailed(true))
    return () => {
      ignore = true
    }
  }, [refreshKey, reloadKey])

  const empty = data !== null && data.stars.length === 0
  const list = data && !empty ? <StarList stars={data.stars} onOpenStar={onOpenStar} /> : null
  const scene = data !== null && webglAvailable()

  return (
    <main className="universe">
      {data === null ? (
        failed && <p className="universe__empty">無法載入星星</p>
      ) : scene ? (
        <SceneBoundary fallback={list}>
          <Suspense fallback={null}>
            <UniverseScene
              stars={data.stars}
              groups={data.groups}
              onOpenStar={onOpenStar}
              onChanged={reload}
              structureOpen={structureOpen}
              onStructureOpenChange={onStructureOpenChange}
              covered={covered}
            />
          </Suspense>
        </SceneBoundary>
      ) : (
        list
      )}
      {empty && <p className="universe__empty">你的宇宙還沒有星星</p>}
      {/* 瀏覽器不支援 3D 時改用清單，結構面板照樣能管理群組 */}
      {data !== null && !scene && (
        <StructureTree
          open={structureOpen}
          onClose={() => onStructureOpenChange(false)}
          groups={data.groups}
          stars={data.stars}
          onChanged={reload}
          onFocusGroup={() => {}}
          onOpenStar={onOpenStar}
        />
      )}
    </main>
  )
})
