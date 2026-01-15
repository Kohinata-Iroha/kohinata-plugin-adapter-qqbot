import fs from 'node:fs'
import path from 'node:path'
import { dirPath } from '@/utils'
import {
  watch,
  karinPathBase,
  requireFileSync,
  common,
} from 'node-karin'
import type { Config, QQBotConfig } from '@/types/config'
import { stopWebSocketConnection } from '@/connection/webSocket'
import { createBot } from '@/core'

let cache: Config | undefined
const cacheMap: Record<string, QQBotConfig> = {}
/** 最近一次已应用（已处理并触发 createBot/stop 的）配置快照，用于去抖后的 diff */
let lastApplied: Config | undefined

/**
 * @description package.json
 */
export const pkg = () => requireFileSync(`${dirPath}/package.json`)

/** 用户配置的插件名称 */
const pluginName = pkg().name
/** 用户配置（统一使用 scope 目录结构：@kohinata/adapter-qqbot/config） */
const dirConfig = path.join(karinPathBase, pluginName, 'config')
/** 旧路径兼容：@karinjs/@kohinata-adapter-qqbot/config */
const legacyDirConfig = path.join(karinPathBase, pkg().name.replace(/\//g, '-'), 'config')

/**
 * 迁移旧配置目录到新目录（一次性）
 * - 仅在旧目录存在、新目录不存在时执行
 */
const migrateLegacyConfigIfNeeded = () => {
  try {
    if (!fs.existsSync(legacyDirConfig)) return
    if (fs.existsSync(dirConfig)) return

    fs.mkdirSync(dirConfig, { recursive: true })
    const legacyCfg = path.join(legacyDirConfig, 'config.json')
    const newCfg = path.join(dirConfig, 'config.json')
    if (fs.existsSync(legacyCfg) && !fs.existsSync(newCfg)) {
      fs.copyFileSync(legacyCfg, newCfg)
    }
  } catch {
    // ignore
  }
}

/**
 * 确保目录存在
 */
const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * @description 配置文件
*/
export const config = (): Config => {
  migrateLegacyConfigIfNeeded()
  const cfgPath = path.join(dirConfig, 'config.json')
  // 不自动创建默认配置文件：完全由 WebUI 保存时创建
  ensureDir(dirConfig)
  if (!fs.existsSync(cfgPath)) {
    cache = []
    lastApplied = []
    return []
  }
  if (cache) return cache
  const user = requireFileSync<Config>(cfgPath)
  const result = formatConfig(user)
  cache = result
  lastApplied = result
  result.forEach(v => {
    cacheMap[v.appId] = v
  })
  return result
}

/**
 * 获取Bot配置
 * @param appid 机器人appid
 * @returns 机器人配置
 */
export const getConfig = (appid: string) => {
  return cacheMap[appid]
}

/**
 * 清理配置：移除等于默认值的字段，保持文件简洁（这些字段无需手动配置）
 */
const cleanConfigForWrite = (config: Config): Config => {
  const def = getDefaultConfig()[0]
  return config.map(item => {
    const cleaned: any = { ...item }

    // 移除等于默认值的字段，这些字段无需手动配置
    if (cleaned.prodApi === def.prodApi) delete cleaned.prodApi
    if (cleaned.sandboxApi === def.sandboxApi) delete cleaned.sandboxApi
    if (cleaned.tokenApi === def.tokenApi) delete cleaned.tokenApi

    // 清理 event 对象中的默认值字段
    if (cleaned.event) {
      if (cleaned.event.wsUrl === def.event.wsUrl) delete cleaned.event.wsUrl
      if (cleaned.event.wsToken === def.event.wsToken) delete cleaned.event.wsToken
      // 如果 event 只剩下 type: 0（默认值），可以删除整个 event
      if (cleaned.event.type === 0 && Object.keys(cleaned.event).length === 1) {
        delete cleaned.event
      }
    }

    return cleaned
  })
}

/**
 * 写入配置（自动格式化并填充默认值，确保手动编辑和 WebUI 配置同步）
 * 写入时会移除等于默认值的字段，保持文件简洁
 * @param config 配置
 */
export const writeConfig = (config: Config) => {
  ensureDir(dirConfig)
  // 写入前先格式化，确保所有默认值都被填充
  const formatted = formatConfig(config)
  // 清理默认值字段，保持文件简洁（这些字段无需手动配置）
  const cleaned = cleanConfigForWrite(formatted)
  fs.writeFileSync(`${dirConfig}/config.json`, JSON.stringify(cleaned, null, 2))
}

/**
 * 格式化config，自动填充默认值
 */
export const formatConfig = (user: Config): Config => {
  const def = getDefaultConfig()[0]
  const result: Config = []

  user.forEach(item => {
    // 合并默认值，空字符串字段使用默认值
    const formatted: QQBotConfig = {
      ...def,
      ...item,
      // 如果字段为空字符串，使用默认值
      prodApi: item.prodApi || def.prodApi,
      sandboxApi: item.sandboxApi || def.sandboxApi,
      tokenApi: item.tokenApi || def.tokenApi,
      event: {
        ...def.event,
        ...item.event,
        // wsUrl 如果为空，使用默认值（根据 sandbox 决定）
        wsUrl: item.event?.wsUrl || def.event.wsUrl,
        wsToken: item.event?.wsToken || def.event.wsToken,
      },
      markdown: {
        ...def.markdown,
        ...item.markdown,
      },
    }
    result.push(formatted)
  })

  // 按 appId 去重：同一 appId 只保留最后一条配置，避免出现“一个 appId 多 Bot / 多连接”
  const uniq = new Map<string, QQBotConfig>()
  result.forEach((cfg) => {
    const id = String(cfg.appId || '').trim()
    if (!id) return
    uniq.set(id, cfg)
  })
  return Array.from(uniq.values())
}

/**
 * 默认配置
 */
export const getDefaultConfig = (): Config => [
  {
    appId: '',
    secret: '',
    prodApi: 'https://api.sgroup.qq.com',
    sandboxApi: 'https://sandbox.api.sgroup.qq.com',
    tokenApi: 'https://bots.qq.com/app/getAppAccessToken',
    sandbox: false,
    qqEnable: true,
    guildEnable: true,
    guildMode: 0,
    exclude: [],
    regex: [
      {
        reg: '^/',
        rep: '#',
      },
    ],
    markdown: {
      mode: 0,
      id: '',
      kv: [
        'text_start',
        'img_dec',
        'img_url',
        'text_end',
      ],
    },
    event: {
      type: 0,
      wsUrl: 'wss://sandbox.api.sgroup.qq.com/websocket/',
      wsToken: '',
    },
  },
]

/**
 * @description 监听配置文件
 */
setTimeout(() => {
  // 去抖：文件保存过程可能触发多次 change（甚至内容未稳定），只处理最后一次
  let debounceTimer: NodeJS.Timeout | null = null
  let pendingNow: Config | null = null

  migrateLegacyConfigIfNeeded()
  const cfgPath = path.join(dirConfig, 'config.json')
  ensureDir(dirConfig)

  const applyConfigChange = async () => {
    if (!pendingNow) return

    const nowFormatted = formatConfig(pendingNow)
    cache = nowFormatted
    lastApplied ||= nowFormatted

    nowFormatted.forEach(v => {
      cacheMap[v.appId] = v
    })

    const result = common.diffArray(lastApplied, nowFormatted)

    // 需要处理的 appId（新增 + 变更）
    const allAppIds = new Set<string>()
    result.added.forEach(v => allAppIds.add(v.appId))
    result.common.forEach((newItem) => {
      const oldItem = lastApplied!.find(o => o.appId === newItem.appId)
      if (oldItem && JSON.stringify(oldItem) !== JSON.stringify(newItem)) {
        allAppIds.add(newItem.appId)
      }
    })

    // 先处理移除：关闭旧连接（Bot 实例清理由 createBot 内部的 destroyBot 处理）
    if (result.removed.length > 0) {
      result.removed.forEach(v => {
        if (v.event.type === 2) stopWebSocketConnection(v.appId)
      })
    }

    // 再处理新增/变更：按顺序 await，避免同一 appId 并发 createBot 造成竞态
    for (const v of nowFormatted) {
      if (!allAppIds.has(v.appId)) continue
      if (v.event.type === 0) continue
      await createBot(v)
    }

    lastApplied = nowFormatted
    pendingNow = null
  }

  const startWatch = () => {
    try {
      watch<Config>(cfgPath, (_old, now) => {
        pendingNow = now
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          debounceTimer = null
          applyConfigChange().catch(() => { })
        }, 250)
      })
    } catch {
      // ignore
    }
  }

  // 文件不存在时不监听；等待 WebUI 首次保存后再启动监听
  if (fs.existsSync(cfgPath)) {
    startWatch()
  } else {
    const timer = setInterval(() => {
      if (fs.existsSync(cfgPath)) {
        clearInterval(timer)
        startWatch()
      }
    }, 1000)
  }
}, 2000)
