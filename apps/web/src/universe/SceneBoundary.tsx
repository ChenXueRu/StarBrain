import { Component } from 'react'
import type { ReactNode } from 'react'

type Props = { fallback: ReactNode; children: ReactNode }

// 3D 場景載入或啟動失敗（chunk 下載失敗、WebGL 建立失敗）時改顯示備用畫面
export class SceneBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
