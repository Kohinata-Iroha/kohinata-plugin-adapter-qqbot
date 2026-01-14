import { Config } from './types'
import { pkg, config, writeConfig } from './utils'
import { defineConfig, components } from 'node-karin'

export default defineConfig({
  info: {
    id: pkg().name,
    name: 'QQBot适配器',
    version: pkg().version,
    description: '为karin提供QQ官方Bot连接能力',
    author: [
      {
        name: 'Kohinata Iroha',
        avatar: 'https://avatars.githubusercontent.com/u/167739314?v=4&size=64'
      }
    ]
  },
  components: () => {
    const data: any[] = []

    const cfg = config.config()
    cfg.forEach((item) => {
      data.push({
        title: item.appId || '未命名配置',
        subtitle: '',
        appId: item.appId || '',
        secret: item.secret || '',
        sandbox: Boolean(item.sandbox),
        qqEnable: item.qqEnable !== undefined ? Boolean(item.qqEnable) : true,
        guildEnable: item.guildEnable !== undefined ? Boolean(item.guildEnable) : true,
        guildMode: item.guildMode !== undefined ? Number(item.guildMode) : 0,
        exclude: Array.isArray(item.exclude) ? item.exclude.map((e: any) => String(e)) : [],
        regex: Array.isArray(item.regex)
          ? item.regex.map((r: any) => `<${String(r.reg || '')}> <${String(r.rep || '')}>`)
          : [],
        markdownMode: item.markdown?.mode !== undefined ? String(item.markdown.mode) : '0',
        markdownId: item.markdown?.id || '',
        markdownKv: Array.isArray(item.markdown?.kv) ? item.markdown.kv.map((k: any) => String(k)) : [],
        eventType: item.event?.type !== undefined ? String(item.event.type) : '2',
      })
    })

    return [
      components.accordionPro.create(
        'qqbot',
        data,
        {
          label: 'QQBot',
          description: 'QQBot配置',
          children: components.accordion.createItem('qqbotConfigItem', {
            title: 'QQBot配置项',
            subtitle: '配置QQBot相关参数',
            children: [
              components.input.create('appId', {
                label: 'AppID',
                description: '请输入你的AppID',
                isRequired: true,
              }),
              components.input.create('secret', {
                label: 'Secret',
                description: '请输入你的Secret',
                isRequired: true,
              }),
              components.switch.create('sandbox', {
                label: '沙盒环境',
                description: '是否启用沙盒环境',
                defaultSelected: false,
              }),
              components.switch.create('qqEnable', {
                label: 'QQ场景',
                description: '是否启用QQ场景',
                defaultSelected: true,
              }),
              components.switch.create('guildEnable', {
                label: '频道场景',
                description: '是否启用频道场景',
                defaultSelected: true,
              }),
              components.switch.create('guildMode', {
                label: '频道场景模式',
                description: '频道场景模式 打开为公域 关闭为私域',
                defaultSelected: true,
              }),
              components.input.group('exclude', {
                data: [],
                label: '文本中的url转二维码白名单',
                description: '文本中的url转二维码白名单 配置后将不转换这些url为二维码',
                template: components.input.create('excludeUrl', {
                  label: '白名单',
                }),
              }),
              components.input.group('regex', {
                data: [],
                label: '接受到消息后对文本进行表达式处理',
                description: '格式比较复杂: <reg> <rep> 分别表示正则和替换内容，请正确填写',
                template: components.input.create('regexItem', {
                  label: '正则',
                }),
              }),
              components.radio.group('markdownMode', {
                label: 'markdown发送模式',
                description: '机器人发送模式 0-直接发送 1-原生Markdown 3-旧图文模板Markdown 4-纯文模板Markdown 5-自定义处理',
                defaultValue: '0',
                radio: [
                  components.radio.create('markdownMode0', {
                    label: '直接发送',
                    value: '0',
                  }),
                  components.radio.create('markdownMode1', {
                    label: '原生Markdown',
                    value: '1',
                  }),
                  components.radio.create('markdownMode3', {
                    label: '旧图文模板Markdown',
                    value: '3',
                  }),
                  components.radio.create('markdownMode4', {
                    label: '纯文模板Markdown',
                    value: '4',
                  }),
                  // components.radio.create('markdownMode5', {
                  //   label: '自定义处理',
                  //   value: '5',
                  // }),
                ],
              }),
              components.input.create('markdownId', {
                label: 'markdown模板ID',
                description: '请输入你的markdown模板ID',
              }),
              components.input.group('markdownKv', {
                data: [],
                label: 'markdown模板变量',
                description: '请输入你的markdown模板变量',
                template: components.input.create('markdownKvKey', {
                  label: '变量',
                }),
              }),
              components.radio.group('eventType', {
                label: '事件接收方式',
                radio: [
                  components.radio.create('eventType0', {
                    label: '关闭',
                    value: '0',
                    description: '关闭事件接收 临时禁用',
                  }),
                  components.radio.create('eventType1', {
                    label: 'webhook',
                    value: '1',
                    description: '使用webhook接收事件 需要自行配置Nginx',
                  }),
                  components.radio.create('eventType2', {
                    label: 'ws',
                    value: '2',
                    description: '使用ws接收事件 需要自行配置ws',
                  }),
                ],
              }),
            ],
          }),
        }
      )
    ]
  },
  /** 前端点击保存之后调用的方法 */
  save: (config: {
    qqbot: Array<{
      appId: string
      secret: string
      sandbox: boolean
      qqEnable: boolean
      guildEnable: boolean
      guildMode: 0 | 1 | string | number
      exclude: string[]
      regex: string[]
      markdownMode: 0 | 1 | 3 | 4 | 5 | string | number
      markdownId: string
      markdownKv: string[]
      eventType: 0 | 1 | 2 | string | number
    }>
  }) => {
    try {
      // 这些字段无需用户配置，统一使用内置默认值
      const DEFAULT_PROD_API = 'https://api.sgroup.qq.com'
      const DEFAULT_SANDBOX_API = 'https://sandbox.api.sgroup.qq.com'
      const DEFAULT_TOKEN_API = 'https://bots.qq.com/app/getAppAccessToken'
      const DEFAULT_WS_URL = 'wss://sandbox.api.sgroup.qq.com/websocket/'
      const DEFAULT_WS_TOKEN = ''

      const data: Config = []
      config.qqbot.forEach((item) => {
        // 处理 regex，确保格式正确
        const regexArray = Array.isArray(item.regex) ? item.regex : []
        const processedRegex = regexArray.map((regexItem: any) => {
          if (typeof regexItem === 'string') {
            const parts = regexItem.trim().split(/\s+/)
            if (parts.length >= 2) {
              return {
                reg: parts[0].replace(/^<|>$/g, ''),
                rep: parts.slice(1).join(' ').replace(/^<|>$/g, ''),
              }
            }
          }
          return { reg: '', rep: '' }
        }).filter((r: any) => r.reg && r.rep)

        // 确保类型转换
        const guildMode = typeof item.guildMode === 'string'
          ? (item.guildMode === '1' ? 1 : 0)
          : Number(item.guildMode) || 0

        const markdownMode = typeof item.markdownMode === 'string'
          ? Number(item.markdownMode)
          : Number(item.markdownMode) || 0

        const eventType = typeof item.eventType === 'string'
          ? Number(item.eventType)
          : Number(item.eventType) || 0

        // 验证必填字段
        if (!item.appId || !item.secret) {
          return // 跳过缺少必填字段的项
        }

        data.push({
          appId: String(item.appId || ''),
          secret: String(item.secret || ''),
          prodApi: DEFAULT_PROD_API,
          sandboxApi: DEFAULT_SANDBOX_API,
          tokenApi: DEFAULT_TOKEN_API,
          sandbox: Boolean(item.sandbox),
          qqEnable: Boolean(item.qqEnable),
          guildEnable: Boolean(item.guildEnable),
          guildMode: (guildMode === 1 ? 1 : 0) as 0 | 1,
          exclude: Array.isArray(item.exclude) ? item.exclude.filter((e: any) => e != null).map((e: any) => String(e)) : [],
          regex: processedRegex,
          markdown: {
            mode: ([0, 1, 3, 4, 5].includes(markdownMode) ? markdownMode : 0) as 0 | 1 | 3 | 4 | 5,
            id: String(item.markdownId || ''),
            kv: Array.isArray(item.markdownKv) ? item.markdownKv.filter((k: any) => k != null).map((k: any) => String(k)) : [],
          },
          event: {
            type: ([0, 1, 2].includes(eventType) ? eventType : 0) as 0 | 1 | 2,
            wsUrl: DEFAULT_WS_URL,
            wsToken: DEFAULT_WS_TOKEN,
          },
        })
      })

      if (data.length === 0) {
        return {
          success: false,
          message: '没有有效的配置项可保存'
        }
      }

      // 按 appId 去重：同一 appId 只保留最后一条配置，避免写入重复配置导致多次触发 createBot
      const uniqData = new Map<string, Config[0]>()
      data.forEach((cfg) => {
        const id = String(cfg.appId || '').trim()
        if (id) {
          uniqData.set(id, cfg)
        }
      })
      const finalData = Array.from(uniqData.values())

      if (finalData.length === 0) {
        return {
          success: false,
          message: '没有有效的配置项可保存（去重后为空）'
        }
      }

      writeConfig(finalData)
      return {
        success: true,
        message: `成功保存 ${data.length} 个配置项`
      }
    } catch (error: any) {
      console.error('保存配置失败:', error)
      return {
        success: false,
        message: `保存失败: ${error?.message || String(error) || '未知错误'}`
      }
    }
  }
})
