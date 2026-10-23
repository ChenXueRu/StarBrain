import type { Star } from '../api'
import { gradeName } from '../starUtils'

// 清單檢視：3D 不可用或不想用時的替代，也是無障礙的路徑
export function StarList({ stars, onOpenStar }: { stars: Star[]; onOpenStar: (id: string) => void }) {
  const newestFirst = [...stars].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return (
    <section className="star-list" aria-label="星星清單">
      <h2 className="star-list__title">{stars.length} 顆星</h2>
      <ul>
        {newestFirst.map((star) => (
          <li key={star.id}>
            <button className="star-list__row" onClick={() => onOpenStar(star.id)}>
              <span className="star-list__glyph" role="img" aria-label={star.lit ? '點亮' : '黯淡'}>
                <span
                  className={star.lit ? 'star-glyph star-glyph--lit' : 'star-glyph'}
                  style={{ width: 6 + star.grade * 2, height: 6 + star.grade * 2 }}
                />
              </span>
              <span className="star-list__topic">{star.topic}</span>
              <span className="star-list__count">
                · {gradeName(star.grade)} · {star.recordCount} 次
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
