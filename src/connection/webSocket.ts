import { logger } from 'node-karin'
import { WebSocket } from 'node-karin/ws'
import { event } from '@/utils/common'
import { BotMap, createAxiosInstance } from '@/core/internal/axios'
import { QQBotApi } from '@/core/api'
import type { QQBotConfig } from '@/types/config'
import { Opcode } from '@/types/event'
import type { AdapterQQBotNormal } from '@/core/adapter/normal'
import type { AdapterQQBotMarkdown } from '@/core/adapter/markdown'

/**
 * 缓存连接
 * - 每个 appId 只允许一个“当前有效”的连接（通过 connectionId 做标识）
 */
type WSConnection = {
  socket: WebSocket
  close: (isClose?: boolean) => void
  heartbeatTimer?: NodeJS.Timeout
  /** 当前连接的唯一标识，用于丢弃旧连接的事件 */
  connectionId: symbol
}
const cache = new Map<string, WSConnection>()
/**
 * 连接尝试序号（用于丢弃过期的并发连接尝试）
 */
const attemptSeq = new Map<string, number>()

/**
 * 创建websocket连接
 */
export const createWebSocketConnection = async (
  config: QQBotConfig,
  client: AdapterQQBotNormal | AdapterQQBotMarkdown
): Promise<boolean> => {
  if (config.appId === 'default') return false
  if (config.event.type !== 2) return false

  const appid = config.appId
  const attempt = (attemptSeq.get(appid) || 0) + 1
  attemptSeq.set(appid, attempt)
  const isStale = () => attemptSeq.get(appid) !== attempt

  // 如果已存在連接，先關閉舊連接
  const existingConnection = cache.get(appid)
  if (existingConnection) {
    logger.debug('[QQBot]', `${appid}: 檢測到已存在的 WebSocket 連接，正在關閉舊連接`)
    existingConnection.close(true)
  }

  return new Promise((resolve) => {
    let resolved = false

    const resolveOnce = (success: boolean) => {
      if (!resolved) {
        resolved = true
        resolve(success)
      }
    }

    // 設置連接超時（10秒）
    const connectionTimeout = setTimeout(() => {
      logger.error('[QQBot]', `${appid}: WebSocket 連接超時`)
      resolveOnce(false)
    }, 10000)

    // 確保在 resolve 時清理超時
    const originalResolve = resolve
    resolve = ((value: boolean) => {
      clearTimeout(connectionTimeout)
      originalResolve(value)
    }) as typeof resolve

    try {
      // 从官方API获取WebSocket网关地址
      const url = config.sandbox ? config.sandboxApi : config.prodApi
      const axios = createAxiosInstance(url, appid)
      const api = new QQBotApi(axios)

      api.getGateway().then((gatewayInfo) => {
        if (isStale()) {
          resolveOnce(false)
          return
        }
        const wsUrl = gatewayInfo.url

        if (!wsUrl) {
          logger.error('[QQBot]', `${appid}: 无法获取WebSocket网关地址`)
          resolveOnce(false)
          return
        }

        // 获取缓存的accessToken
        const accessToken = BotMap.get(appid)
        if (!accessToken) {
          logger.error('[QQBot]', `${appid}: 未能获取accessToken`)
          resolveOnce(false)
          return
        }

        // 连接到官方WebSocket网关
        const socket = new WebSocket(wsUrl)
        const connectionId = Symbol('qqbot-ws-connection')

        let heartbeatInterval = 0
        let lastSeq = 0

        /**
         * 关闭连接
         * - 不再自動重連，避免在網關/白名單錯誤時反覆嘗試
         */
        const close = (isClose = false) => {
          try {
            socket.removeAllListeners()
            socket?.close()

            if (isClose) {
              logger.warn('[QQBot]', `${appid}: WebSocket连接已主动关闭`)
            } else {
              logger.error('[QQBot]', `${appid}: WebSocket连接已断开`)
            }
          } finally {
            const ws = cache.get(appid)
            // 只清理仍然指向本 connectionId 的连接，避免误删新连接
            if (ws && ws.connectionId === connectionId) {
              if (ws.heartbeatTimer) {
                clearInterval(ws.heartbeatTimer)
              }
              cache.delete(appid)
            }
          }
        }

        socket.on('close', () => {
          if (isStale()) return
          close(false)
          resolveOnce(false)
        })

        socket.on('error', (error) => {
          if (isStale()) return
          logger.error('[QQBot]', `${appid}: WebSocket错误: ${error}`)
          close()
          resolveOnce(false)
        })

        socket.on('open', () => {
          if (isStale()) {
            try {
              socket.removeAllListeners()
              socket.close()
            } catch { }
            return
          }
          cache.set(appid, { socket, close, connectionId })
          logger.debug('[QQBot]', `${appid}: WebSocket连接已打开`)
          // 連接打開後，等待 READY 事件確認連接成功
        })

        socket.on('message', (rawData) => {
          if (isStale()) return
          const current = cache.get(appid)
          // 只允许当前缓存中的 socket 处理消息，旧连接的消息直接丢弃
          if (!current || current.socket !== socket || current.connectionId !== connectionId) {
            return
          }
          const raw = rawData.toString()
          const data = JSON.parse(raw)

          // 處理 READY 事件，標記連接成功
          if (data.op === Opcode.Dispatch && data.t === 'READY') {
            logger.debug('[QQBot]', `${appid}: WebSocket 連接成功，收到 READY 事件`)
            resolveOnce(true)
          }

          handleWebSocketMessage(config, client, data, socket, (seq) => { lastSeq = seq }, (si) => {
            // sessionId 不再使用，但保留參數以保持兼容
          }, (interval) => {
            heartbeatInterval = interval

            // 启动心跳
            const ws = cache.get(appid)
            if (ws?.heartbeatTimer) {
              clearInterval(ws.heartbeatTimer)
            }

            const heartbeatTimer = setInterval(() => {
              socket.send(JSON.stringify({ op: Opcode.Heartbeat, d: lastSeq }))
            }, heartbeatInterval)

            const wsData = cache.get(appid)
            if (wsData) {
              wsData.heartbeatTimer = heartbeatTimer
            }
          })
        })
      }).catch((error) => {
        if (isStale()) return
        logger.error('[QQBot]', `${appid}: 创建WebSocket连接失败: ${error}`)
        resolveOnce(false)
      })
    } catch (error) {
      if (isStale()) return
      logger.error('[QQBot]', `${appid}: 创建WebSocket连接失败: ${error}`)
      resolveOnce(false)
    }
  })
}

/**
 * 处理WebSocket消息
 */
const handleWebSocketMessage = (
  config: QQBotConfig,
  client: AdapterQQBotNormal | AdapterQQBotMarkdown,
  data: any,
  socket: WebSocket,
  setSeq: (seq: number) => void,
  setSessionId: (id: string) => void,
  setHeartbeatInterval: (interval: number) => void
) => {
  const { op, d, t, s } = data
  const appid = config.appId
  const accessToken = BotMap.get(appid)

  // 处理序列号
  if (s !== null && s !== undefined) {
    setSeq(s)
  }

  switch (op) {
    case Opcode.Hello:
      // 接收Hello消息，获取心跳间隔
      logger.debug('[QQBot]', `${appid}: 收到Hello消息，心跳间隔: ${d.heartbeat_interval}ms`)
      setHeartbeatInterval(d.heartbeat_interval)

      // 发送Identify进行认证
      // Token格式为 "QQBot {AccessToken}"
      socket.send(JSON.stringify({
        op: Opcode.Identify,
        d: {
          token: `QQBot ${accessToken}`,
          intents: 33558531, // 订阅所有必需的事件 (1|1<<1|1<<9|1<<10|1<<12|1<<25|1<<26|1<<27|1<<28|1<<29|1<<30)
          shard: [0, 1],
          properties: {
            $os: 'linux',
            $browser: 'karin',
            $device: 'karin'
          }
        }
      }))
      logger.debug('[QQBot]', `${appid}: 已发送Identify鉴权消息`)
      break

    case Opcode.Dispatch:
      // 处理事件
      if (t === 'READY') {
        setSessionId(d.session_id)
        logger.debug('[QQBot]', `${appid}: WebSocket登录成功，会话 ID: ${d.session_id}`)
      }

      // 转发完整的事件对象，包括 t 字段
      event.emit(appid, { op, s, t, d } as any)
      break

    case Opcode.HeartbeatACK:
      logger.debug('[QQBot]', `${appid}: 收到心跳ACK`)
      break

    case Opcode.Reconnect:
      logger.warn('[QQBot]', `${appid}: 服务器要求重连`)
      socket.close()
      break

    case Opcode.InvalidSession:
      logger.error('[QQBot]', `${appid}: 会话无效，需要重新认证`)
      socket.close()
      break

    default:
      logger.debug('[QQBot]', `${appid}: 未知OpCode: ${op}`)
  }
}/**
 * 停止已有连接
 */
export const stopWebSocketConnection = (appid: string) => {
  // 让当前/后续 in-flight 连接尝试失效
  attemptSeq.set(appid, (attemptSeq.get(appid) || 0) + 1)
  const result = cache.get(appid)
  if (result) {
    // 傳遞 true 表示主動關閉，不觸發重連
    result.close(true)
    return true
  }

  return false
}
