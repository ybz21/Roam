// 订阅 control 链路状态的 React 入口。
//
// store 本体在 transport.ts（那是个纯模块，不该 import react）；这里只是把它接到
// useSyncExternalStore 上，供状态条那一格用。
import { useSyncExternalStore } from 'react'
import { getLinkStatus, subscribeLink, type LinkStatus } from './transport'

export function useLinkStatus(): LinkStatus {
  return useSyncExternalStore(subscribeLink, getLinkStatus, getLinkStatus)
}
