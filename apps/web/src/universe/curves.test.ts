import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { bendControl, fillCurve, quadPoint } from './curves'
import type { Vec3 } from './layout'

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('bendControl', () => {
  test('控制點偏離中點的距離 = 比例 × 連線長度，且和連線垂直', () => {
    const a: Vec3 = [1, 2, 3]
    const b: Vec3 = [7, -2, 9]
    const ctrl: Vec3 = [0, 0, 0]
    bendControl(ctrl, ...a, ...b, 0.9, 0.3)
    const mid: Vec3 = [4, 0, 6]
    const length = dist(a, b)
    assert.ok(Math.abs(dist(ctrl, mid) - 0.3 * length) < 1e-9)
    const offset = [ctrl[0] - mid[0], ctrl[1] - mid[1], ctrl[2] - mid[2]]
    const dot = offset[0] * (b[0] - a[0]) + offset[1] * (b[1] - a[1]) + offset[2] * (b[2] - a[2])
    assert.ok(Math.abs(dot) < 1e-9)
  })

  test('不同角度彎向不同方向，同樣的輸入結果相同', () => {
    const one: Vec3 = [0, 0, 0]
    const two: Vec3 = [0, 0, 0]
    const again: Vec3 = [0, 0, 0]
    bendControl(one, 0, 0, 0, 10, 0, 0, 0.5, 0.3)
    bendControl(two, 0, 0, 0, 10, 0, 0, 2.5, 0.3)
    bendControl(again, 0, 0, 0, 10, 0, 0, 0.5, 0.3)
    assert.ok(dist(one, two) > 0.1)
    assert.deepEqual(one, again)
  })

  test('連線鉛直或長度為零也不會產生 NaN', () => {
    const ctrl: Vec3 = [0, 0, 0]
    bendControl(ctrl, 0, 0, 0, 0, 5, 0, 1, 0.3)
    assert.ok(ctrl.every(Number.isFinite))
    assert.ok(dist(ctrl, [0, 2.5, 0]) > 1)
    bendControl(ctrl, 1, 1, 1, 1, 1, 1, 1, 0.3)
    assert.deepEqual(ctrl, [1, 1, 1])
  })

  test('可以寫進 Float32Array 的指定位置', () => {
    const out = new Float32Array(6)
    bendControl(out, 0, 0, 0, 10, 0, 0, 0, 0.2, 3)
    assert.equal(out[0], 0)
    assert.ok(Math.abs(out[3] - 5) < 1e-6)
  })
})

describe('fillCurve', () => {
  test('頂點從起點走到終點，且中間確實偏離直線', () => {
    const a: Vec3 = [0, 0, 0]
    const b: Vec3 = [10, 0, 0]
    const ctrl: Vec3 = [0, 0, 0]
    bendControl(ctrl, ...a, ...b, 0, 0.3)
    const out = new Float32Array(9 * 3)
    fillCurve(out, 0, 8, ...a, ...ctrl, ...b)
    assert.deepEqual([out[0], out[1], out[2]], [0, 0, 0])
    assert.deepEqual([out[24], out[25], out[26]], [10, 0, 0])
    const middle = [out[12], out[13], out[14]]
    // 二次貝茲曲線的中點離控制點與中點連線的一半
    assert.ok(Math.abs(Math.hypot(middle[1], middle[2]) - 1.5) < 1e-5)
  })

  test('quadPoint 在 t = 0.5 時是端點與控制點的加權平均', () => {
    const out: Vec3 = [0, 0, 0]
    quadPoint(out, 0, 0.5, 0, 0, 0, 4, 8, 0, 8, 0, 0)
    assert.deepEqual(out, [4, 4, 0])
  })
})
