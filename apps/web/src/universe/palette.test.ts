import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { LayoutGroup } from './layout'
import { NEUTRAL_COLOR, SUPERCLUSTER_COLORS, buildGroupStyles, mixHex, shiftHue } from './palette'

const group = (id: string, level: number, name: string, parentId: string | null = null): LayoutGroup => ({ id, level, name, parentId })

describe('buildGroupStyles', () => {
  const groups = [
    group('v', 3, '價值觀'),
    group('l', 3, '生活態度'),
    group('c1', 2, '人生目標', 'v'),
    group('g1', 1, '星系甲', 'c1'),
    group('g2', 1, '星系乙', 'c1'),
    group('c2', 2, '健康', 'l'),
    group('lone', 1, '獨立星系'),
  ]
  const styles = buildGroupStyles(groups)

  test('超星系團用固定的招牌色', () => {
    assert.equal(styles.get('v')?.color, SUPERCLUSTER_COLORS['價值觀'])
    assert.equal(styles.get('l')?.color, SUPERCLUSTER_COLORS['生活態度'])
  })

  test('底下的群組沿用最上層祖先的招牌色與 rootId', () => {
    assert.equal(styles.get('g1')?.rootId, 'v')
    assert.equal(styles.get('g1')?.rootColor, SUPERCLUSTER_COLORS['價值觀'])
    assert.equal(styles.get('c2')?.rootId, 'l')
    assert.notEqual(styles.get('c2')?.color, styles.get('g1')?.color)
  })

  test('每個超星系團有和招牌色不同的第二色，底下的群組共用', () => {
    assert.notEqual(styles.get('v')?.accent, styles.get('v')?.rootColor)
    assert.equal(styles.get('g1')?.accent, styles.get('v')?.accent)
  })

  test('沒有歸入超星系團的群組用中性色，結果可重現', () => {
    assert.equal(styles.get('lone')?.rootColor, NEUTRAL_COLOR)
    assert.deepEqual(buildGroupStyles(groups), styles)
  })

  test('同一個超星系團底下的星系色相略有不同', () => {
    assert.notEqual(styles.get('g1')?.color, styles.get('g2')?.color)
  })
})

describe('顏色工具', () => {
  test('shiftHue 轉一整圈回到原色，亮度偏移不超出範圍', () => {
    assert.equal(shiftHue('#c084fc', 1), '#c084fc')
    assert.match(shiftHue('#c084fc', 0.1, 5), /^#[0-9a-f]{6}$/)
  })

  test('mixHex 兩端是原色', () => {
    assert.equal(mixHex('#000000', '#ffffff', 0), '#000000')
    assert.equal(mixHex('#000000', '#ffffff', 1), '#ffffff')
    assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080')
  })
})
