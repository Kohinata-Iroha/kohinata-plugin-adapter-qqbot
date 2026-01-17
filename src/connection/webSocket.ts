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
 * - 每个 appId 只允许一个"当前有效"的连接（通过 connectionId 做标识）
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
 * 重连尝试次数记录（用于自动重连）
 */
const reconnectAttempts = new Map<string, number>()

/**
 * 尝试自动重连（最多5次）
 */
const attemptReconnect = async (
  config: QQBotConfig,
  client: AdapterQQBotNormal | AdapterQQBotMarkdown,
  currentAttempt: number
) => {
  const appid = config.appId
  const maxAttempts = 5

  // 清除重连计数（如果连接成功）
  const clearReconnectCount = () => {
    reconnectAttempts.delete(appid)
  }

  // 如果已达到最大重连次数，停止重连
  if (currentAttempt >= maxAttempts) {
    logger.error('[QQBot]', `${appid}: 已达到最大重连次数 (${maxAttempts})，停止重连`)
    reconnectAttempts.delete(appid)
    return
  }

  const attempt = currentAttempt + 1
  reconnectAttempts.set(appid, attempt)

  logger.debug('[QQBot]', `${appid}: 开始第 ${attempt}/${maxAttempts} 次重连尝试`)

  // 等待一段时间后重连（指数退避：1s, 2s, 4s, 8s, 16s）
  const delay = Math.min(1000 * Math.pow(2, currentAttempt), 16000)
  await new Promise(resolve => setTimeout(resolve, delay))

  // 检查是否还有重连记录（可能已被手动停止）
  if (reconnectAttempts.get(appid) !== attempt) {
    return
  }

  // 尝试重新连接
  const success = await createWebSocketConnection(config, client)

  if (!success) {
    // 连接失败，继续重连
    logger.warn('[QQBot]', `${appid}: 第 ${attempt} 次重连失败，将在 ${Math.min(1000 * Math.pow(2, attempt), 16000)}ms 后重试`)
    attemptReconnect(config, client, attempt)
  } else {
    // 连接成功，清除重连计数
    clearReconnectCount()
    logger.debug('[QQBot]', `${appid}: 第 ${attempt} 次重连成功`)
  }
}

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
        let isReady = false // 标记是否已成功建立连接

        /**
         * 关闭连接
         * - 不再自動重連，避免在網關/白名單錯誤時反覆嘗試
         */
        const close = (isClose = false) => {
          try {
            socket.removeAllListeners()
            socket?.close()

            if (isClose) {
              logger.debug('[QQBot]', `${appid}: WebSocket连接已主动关闭`)
            } else {
              logger.debug('[QQBot]', `${appid}: WebSocket连接已断开`)
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

        socket.on('close', (code, reason) => {
          if (isStale()) return
          const wasReady = isReady
          close(false)
          resolveOnce(false)
          // 如果连接已成功建立过（收到过 READY），且不是主动关闭，则尝试重连
          if (wasReady && code !== 1000 && code !== 1001) {
            attemptReconnect(config, client, 0)
          }
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
            isReady = true
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
const buildIntents = (cfg: QQBotConfig): number => {
  let intents = 0

  // 基礎事件：Guild / 成員 / DM / 群&單聊
  // GUILDS
  intents |= 1 << 0
  // GUILD_MEMBERS
  intents |= 1 << 1
  // DIRECT_MESSAGE
  intents |= 1 << 12
  // GROUP_AND_C2C_EVENT
  intents |= 1 << 25

  // 文字子頻道消息：根據 guildMode 決定使用公域或私域事件
  if (cfg.guildMode === 1) {
    // 私域：GUILD_MESSAGES -> MESSAGE_CREATE
    intents |= 1 << 9
  } else {
    // 公域：PUBLIC_GUILD_MESSAGES -> AT_MESSAGE_CREATE
    intents |= 1 << 30
  }

  return intents
}

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
          // 根據配置動態構建 intents，確保開啟文字子頻道消息事件
          intents: buildIntents(config),
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
      // 触发自动重连
      attemptReconnect(config, client, 0)
      break

    case Opcode.InvalidSession:
      logger.error('[QQBot]', `${appid}: 会话无效，需要重新认证`)
      socket.close()
      break

    default:
      logger.debug('[QQBot]', `${appid}: 未知OpCode: ${op}`)
  }
}
/**
 * 停止已有连接
 */
export const stopWebSocketConnection = (appid: string) => {
  // 让当前/后续 in-flight 连接尝试失效
  attemptSeq.set(appid, (attemptSeq.get(appid) || 0) + 1)
  // 清除重连计数
  reconnectAttempts.delete(appid)
  const result = cache.get(appid)
  if (result) {
    // 傳遞 true 表示主動關閉，不觸發重連
    result.close(true)
    return true
  }

  return false
}
