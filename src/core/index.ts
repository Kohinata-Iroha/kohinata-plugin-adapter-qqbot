import { URL } from 'url'
import { QQBotApi } from '@/core/api'
import { event } from '@/utils/common'
import { config, pkg } from '@/utils/config'
import { EventEnum } from '@/types/event'
import { logger, registerBot } from 'node-karin'
import { AdapterQQBotNormal } from '@/core/adapter/normal'
import { AdapterQQBotMarkdown } from '@/core/adapter/markdown'
import { createAxiosInstance, getAccessToken } from '@/core/internal/axios'
import { GraphicTemplateMarkdown, rawMarkdown } from '@/core/adapter/handler'
import { onChannelMsg, onDirectMsg, onFriendMsg, onGroupMsg } from '@/core/event/message'
import { onGroupAddRobot, onGroupDelRobot, onFriendAdd, onFriendDel, onC2CMsgReceive, onC2CMsgReject, onGroupMsgReceive, onGroupMsgReject } from '@/core/event/notice'
import { createWebSocketConnection, stopWebSocketConnection } from '@/connection/webSocket'

import type { QQBotConfig } from '@/types/config'
import type {
  Event,
  GuildCreateEvent,
  GuildUpdateEvent,
  GuildDeleteEvent,
  ChannelCreateEvent,
  ChannelUpdateEvent,
  ChannelDeleteEvent,
  GuildMemberAddEvent,
  GuildMemberUpdateEvent,
  GuildMemberRemoveEvent,
  MessageReactionAddEvent,
  MessageReactionRemoveEvent,
  GuildMessageDeleteEvent,
  PublicMessageDeleteEvent,
  DirectMessageDeleteEvent,
  FriendAddEvent,
  FriendDelEvent,
  C2CMsgReceiveEvent,
  C2CMsgRejectEvent,
  GroupMsgReceiveEvent,
  GroupMsgRejectEvent
} from '@/types/event'

/**
 * 追蹤已創建的 Bot 實例（以 appId 為唯一鍵）。
 * 注意：node-karin 沒有提供對應的 unregister 能力時，重複 registerBot 會造成「看起來多出一個 Bot」。
 * 因此這裡保證：同一個 appId 只會 registerBot 一次，後續配置變更只做“更新/重連”。
 */
type BotInstance = {
  client: AdapterQQBotNormal | AdapterQQBotMarkdown
  config: QQBotConfig
  /** 是否已經向 node-karin registerBot 過（避免重複註冊） */
  registered: boolean
  /** 已註冊的類型（避免配置切換導致重複註冊） */
  registeredType: 'webSocketClient' | 'http' | null
}
export const botInstances = new Map<string, BotInstance>()

/**
 * 初始化Bot列表
 */
export const initQQBotAdapter = async () => {
  const cfg = config()
  cfg.forEach(bot => createBot(bot))
}

/**
 * 停止 bot 的运行态（连接/监听），但不重复 registerBot。
 */
const stopRuntime = (appId: string) => {
  stopWebSocketConnection(appId)
  event.removeAllListeners(appId)
}

/**
 * 创建Bot实例
 * @param bot 机器人配置
 */
export const createBot = async (bot: QQBotConfig) => {
  if (bot.event.type === 0) {
    logger.debug('[QQBot]', `${bot.appId}: bot已关闭，跳过初始化`)
    // 如果已存在實例，清理它
    const id = String(bot.appId)
    stopRuntime(id)
    botInstances.delete(id)
    return
  }

  const appId = String(bot.appId)

  // 若已存在实例：停止旧运行态，但复用同一个 client，避免重复 registerBot 造成多 Bot
  const existing = botInstances.get(appId)
  if (existing) {
    stopRuntime(appId)
    existing.config = bot

    // 更新 adapter 连接信息（地址/secret/version）
    const url = bot.sandbox ? bot.sandboxApi : bot.prodApi
    existing.client.adapter.address = url
    existing.client.adapter.secret = bot.secret
    existing.client.adapter.version = pkg().version

    // 重新挂载事件监听（只挂一次）
    event.on(appId, (evt: Event) => createEvent(existing.client, evt))

    // 重新建立连接：WebSocket 只做重连，不再 registerBot
    if (bot.event.type === 2) {
      await createWebSocketConnection(bot, existing.client)
    }

    return
  }

  try {
    // 获取accessToken - 从官方API获取
    await getAccessToken(appId, bot.secret)

    const url = bot.sandbox ? bot.sandboxApi : bot.prodApi
    const axios = createAxiosInstance(url, appId)

    const api = new QQBotApi(axios)

    // 获取机器人信息，如果失败则直接返回错误
    const data = await api.getMe()
    if (!data?.id) {
      throw new Error(`${appId}: 无法获取机器人详情，获取到的数据无效`)
    }

    const id = data.id
    const username = data.username || `Bot_${appId}`
    const avatar = data.avatar || ''
    const qq = data.share_url ? (new URL(data.share_url).searchParams.get('robot_uin') || appId) : appId
    const unionOpenid = data.union_openid || appId

    const client = createClient(bot, api)
    client.account.name = username
    client.account.avatar = avatar
    client.account.selfId = appId

    client.account.subId.id = id
    client.account.subId.qq = qq
    client.account.subId.appid = appId
    client.account.subId.union_openid = unionOpenid

    // 填寫適配器基本信息
    client.adapter.address = url
    client.adapter.secret = bot.secret
    client.adapter.version = pkg().version

    if (bot.event.type === 2) {
      // WebSocket 模式：先嘗試建立 WebSocket 連接，成功後再註冊 Bot
      const wsResult = await createWebSocketConnection(bot, client)
      if (!wsResult) {
        // 連接失敗，直接跳過 Bot 註冊，避免日誌中出現「已連接」的錯覺
        logger.debug('[QQBot]', `${appId}: WebSocket 連接失敗，跳過 Bot 註冊`)
        return
      }

      // 只有在 WS 連接成功後才註冊事件監聽器與 Bot，避免失敗殘留導致重複處理
      event.on(appId, (event: Event) => createEvent(client, event))
      client.adapter.index = registerBot('webSocketClient', client)
      botInstances.set(appId, { client, config: bot, registered: true, registeredType: 'webSocketClient' })
    } else {
      // HTTP 模式：直接註冊
      event.on(appId, (event: Event) => createEvent(client, event))
      client.adapter.index = registerBot('http', client)
      botInstances.set(appId, { client, config: bot, registered: true, registeredType: 'http' })
    }
  } catch (error) {
    stopRuntime(appId)
    botInstances.delete(appId)
    throw error
  }
}

/**
 * 创建QQBot客户端
 * @param cfg 机器人配置
 * @param api 机器人API
 */
const createClient = (cfg: QQBotConfig, api: QQBotApi): AdapterQQBotNormal | AdapterQQBotMarkdown => {
  const mode = Number(cfg.markdown?.mode) || 0

  // 模式 0: 正常模式
  if (mode === 0) {
    return new AdapterQQBotNormal(api, cfg)
  }

  // 模式 1: 原生Markdown
  if (mode === 1) {
    return new AdapterQQBotMarkdown(api, rawMarkdown, cfg)
  }

  // 模式 3/4/5: 图文模板Markdown
  if (mode >= 3 && mode <= 5) {
    return new AdapterQQBotMarkdown(api, GraphicTemplateMarkdown, cfg)
  }

  // 默认返回正常模式
  return new AdapterQQBotNormal(api, cfg)
}

/**
 * 创建事件
 * @param client 机器人实例
 * @param event 事件
 */
export const createEvent = (
  client: AdapterQQBotNormal | AdapterQQBotMarkdown,
  event: Event
): void => {
  switch (event.t) {
    case EventEnum.READY:
      // READY 事件已在 WebSocket 连接中处理，这里静默处理
      return
    case EventEnum.RESUMED:
      // RESUMED 事件表示恢复连接成功，静默处理
      return
    case EventEnum.GROUP_AT_MESSAGE_CREATE:
      return onGroupMsg(client, event)
    case EventEnum.C2C_MESSAGE_CREATE:
      return onFriendMsg(client, event)
    case EventEnum.MESSAGE_CREATE:
    case EventEnum.AT_MESSAGE_CREATE:
      // 频道消息（公域/私域）
      client.logger('debug', `收到频道消息事件: ${JSON.stringify(event.d || {})}`)
      return onChannelMsg(client, event)
    case EventEnum.GUILD_CREATE: {
      const d = (event as GuildCreateEvent).d || {}
      const gid = d.id || d.guild_id || 'unknown'
      const name = d.name || ''
      client.logger('info', `机器人加入频道: [${gid}] ${name}`)
      return
    }
    case EventEnum.GUILD_UPDATE: {
      const d = (event as GuildUpdateEvent).d || {}
      const gid = d.id || d.guild_id || 'unknown'
      client.logger('info', `频道资料更新: [${gid}] ${d.name || ''}`)
      return
    }
    case EventEnum.GUILD_DELETE: {
      const d = (event as GuildDeleteEvent).d || {}
      const gid = d.id || d.guild_id || 'unknown'
      client.logger('info', `机器人退出频道: [${gid}]`)
      return
    }
    case EventEnum.CHANNEL_CREATE: {
      const d = (event as ChannelCreateEvent).d || {}
      const cid = d.id || d.channel_id || 'unknown'
      const gid = d.guild_id || d.guildId || 'unknown'
      client.logger('info', `子频道创建: [${cid}] 所属频道: [${gid}] ${d.name || ''}`)
      return
    }
    case EventEnum.CHANNEL_UPDATE: {
      const d = (event as ChannelUpdateEvent).d || {}
      const cid = d.id || d.channel_id || 'unknown'
      const gid = d.guild_id || d.guildId || 'unknown'
      client.logger('info', `子频道更新: [${cid}] 所属频道: [${gid}] ${d.name || ''}`)
      return
    }
    case EventEnum.CHANNEL_DELETE: {
      const d = (event as ChannelDeleteEvent).d || {}
      const cid = d.id || d.channel_id || 'unknown'
      const gid = d.guild_id || d.guildId || 'unknown'
      client.logger('info', `子频道删除: [${cid}] 所属频道: [${gid}]`)
      return
    }
    case EventEnum.GUILD_MEMBER_ADD: {
      const d = (event as GuildMemberAddEvent).d || {}
      const member = d.member || d.user || {}
      const uid = member.id || member.user_openid || 'unknown'
      const gid = d.guild_id || 'unknown'
      client.logger('info', `成员加入频道: [${uid}] guild: [${gid}]`)
      return
    }
    case EventEnum.GUILD_MEMBER_UPDATE: {
      const d = (event as GuildMemberUpdateEvent).d || {}
      const member = d.member || d.user || {}
      const uid = member.id || member.user_openid || 'unknown'
      const gid = d.guild_id || 'unknown'
      client.logger('info', `成员资料更新: [${uid}] guild: [${gid}]`)
      return
    }
    case EventEnum.GUILD_MEMBER_REMOVE: {
      const d = (event as GuildMemberRemoveEvent).d || {}
      const member = d.member || d.user || {}
      const uid = member.id || member.user_openid || 'unknown'
      const gid = d.guild_id || 'unknown'
      client.logger('info', `成员移除: [${uid}] guild: [${gid}]`)
      return
    }
    case EventEnum.MESSAGE_REACTION_ADD: {
      const d = (event as MessageReactionAddEvent).d || {}
      client.logger('info', `消息表态添加: ${JSON.stringify(d)}`)
      return
    }
    case EventEnum.MESSAGE_REACTION_REMOVE: {
      const d = (event as MessageReactionRemoveEvent).d || {}
      client.logger('info', `消息表态移除: ${JSON.stringify(d)}`)
      return
    }
    case EventEnum.DIRECT_MESSAGE_CREATE:
      return onDirectMsg(client, event)
    case EventEnum.MESSAGE_DELETE: {
      // 頻道撤回事件（私域）：
      const d = (event as GuildMessageDeleteEvent).d
      const msg = d?.message || {}
      const author = msg?.author || {}
      const userId = author.id || 'unknown'
      const username = author.username || ''
      const messageId = msg.id || 'unknown'
      client.logger('info', `频道用户撤回: [${userId}(${username})] ${messageId}`)
      return
    }
    case EventEnum.PUBLIC_MESSAGE_DELETE: {
      // 頻道撤回事件（公域）：
      const d = (event as PublicMessageDeleteEvent).d
      const msg = d?.message || {}
      const author = msg?.author || {}
      const userId = author.id || 'unknown'
      const username = author.username || ''
      const messageId = msg.id || 'unknown'
      client.logger('info', `频道用户撤回: [${userId}(${username})] ${messageId}`)
      return
    }
    case EventEnum.DIRECT_MESSAGE_DELETE: {
      // 頻道私信撤回事件：
      const d = (event as DirectMessageDeleteEvent).d
      const msg = d?.message || {}
      const author = msg?.author || {}
      const userId = author.id || 'unknown'
      const username = author.username || ''
      const messageId = msg.id || 'unknown'
      client.logger('info', `频道私信用户撤回: [${userId}(${username})] ${messageId}`)
      return
    }
    case EventEnum.C2C_MESSAGE_DELETE:
    case EventEnum.GROUP_AT_MESSAGE_DELETE:
      // 好友/群聊撤回事件：當前版本僅做日誌標記（QQ開放平台暫未提供此類事件）
      logger.debug('[QQBot]', `收到撤回事件: ${event.t} ${JSON.stringify(event.d || {})}`)
      return
    case EventEnum.GROUP_ADD_ROBOT:
      return onGroupAddRobot(client, event)
    case EventEnum.GROUP_DEL_ROBOT:
      return onGroupDelRobot(client, event)
    case EventEnum.FRIEND_ADD:
      return onFriendAdd(client, event as FriendAddEvent)
    case EventEnum.FRIEND_DEL:
      return onFriendDel(client, event as FriendDelEvent)
    case EventEnum.C2C_MSG_RECEIVE:
      return onC2CMsgReceive(client, event as C2CMsgReceiveEvent)
    case EventEnum.C2C_MSG_REJECT:
      return onC2CMsgReject(client, event as C2CMsgRejectEvent)
    case EventEnum.GROUP_MSG_RECEIVE:
      return onGroupMsgReceive(client, event as GroupMsgReceiveEvent)
    case EventEnum.GROUP_MSG_REJECT:
      return onGroupMsgReject(client, event as GroupMsgRejectEvent)
    default:
      logger.error(`未知事件类型: ${JSON.stringify(event)}`)
  }
}
