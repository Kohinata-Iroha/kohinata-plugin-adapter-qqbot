import FormData from 'form-data'
import { qrs, textToButton } from '@/utils/common'
import { fileToUrl, buttonHandle } from 'node-karin'
import { AdapterQQBot } from '@/core/adapter/adapter'
import { SendGuildMsg, SendQQMsg } from '@/core/api/types'
import type { QQBotApi } from '@/core/api'
import type { Contact, ElementTypes, Message, SendMsgResults } from 'node-karin'
import type { RawMarkdown } from '@/core/adapter/handler'
import type { QQBotConfig } from '@/types/config'

/** markdown */
export class AdapterQQBotMarkdown extends AdapterQQBot {
  _config: QQBotConfig
  markdown: RawMarkdown
  constructor (QQBot: QQBotApi, markdown: RawMarkdown, config: QQBotConfig) {
    super(QQBot)
    this.markdown = markdown
    this._config = config
  }

  async srcReply (e: Message, elements: ElementTypes[]) {
    const list = await buttonHandle(e.msg, { e })
    return this.sendMsg(e.contact, [...elements, ...list])
  }

  async sendMsg (contact: Contact, elements: Array<ElementTypes>, retryCount?: number): Promise<SendMsgResults> {
    if (contact.scene === 'direct' || contact.scene === 'guild') {
      return this.sendGuildMsg(contact, elements, retryCount)
    } else if (contact.scene === 'group' || contact.scene === 'friend') {
      return this.sendQQMsg(contact, elements, retryCount)
    }

    throw new Error('不支持的消息类型')
  }

  /**
   * 处理文本 将文本中的链接转为二维码
   * @param text 文本
   * @returns 处理后的文本和二维码列表 二维码为不带`base64://`的字符串
   */
  async hendleText (text: string): Promise<{ text: string, qrs: string[] }> {
    // 检查是否启用转二维码功能
    if (this._config?.enableConvert === false) {
      return { text, qrs: [] }
    }

    // 使用正则表达式匹配URL（匹配 http:// 或 https:// 开头的URL）
    const urlRegex = /https?:\/\/[^\s\u4e00-\u9fa5]+/g
    const matches = text.match(urlRegex)

    if (!matches || matches.length === 0) {
      return { text, qrs: [] }
    }

    // 使用配置的白名单过滤 URL
    const exclude = this._config?.exclude || []
    const urls: string[] = []

    for (const url of matches) {
      // 检查是否在白名单中
      const isExcluded = exclude.some(ex => {
        try {
          const regex = new RegExp(ex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
          return regex.test(url)
        } catch {
          return url.includes(ex)
        }
      })

      if (!isExcluded) {
        urls.push(url)
      }
    }

    if (urls.length === 0) {
      return { text, qrs: [] }
    }

    // 生成二维码
    const qrList: string[] = []
    for (const url of urls) {
      try {
        const qrCode = await qrs([url])
        if (qrCode.length > 0) {
          qrList.push(qrCode[0])
        }
      } catch (error) {
        this.logger('error', `[QQBot] URL转二维码失败: ${url}`, error)
      }
    }

    // 替换文本中的URL为提示文字
    for (const url of urls) {
      const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      text = text.replace(new RegExp(escapedUrl, 'g'), '[链接(请扫码查看)]')
    }

    // 返回所有二维码，分别发送（不使用ffmpeg合并）
    return { text, qrs: qrList }
  }

  /**
   * 发送QQ私聊、群聊消息
   * @param contact 联系人
   * @param elements 消息元素
   * @param retryCount 重试次数
   */
  async sendQQMsg (
    contact: Contact<'friend'> | Contact<'group'>,
    elements: Array<ElementTypes>,
    retryCount?: number
  ): Promise<SendMsgResults> {
    const list = this.initList('qq')

    /** 上传富媒体的目标 */
    const target = contact.scene === 'friend' ? 'user' : 'group'

    for (const v of elements) {
      if (v.type === 'text') {
        const { text, buttons } = textToButton(v.text, contact.scene === 'friend')
        list.content.push(text)
        if (buttons) list.button.push(...buttons)
        continue
      }

      if (v.type === 'at') {
        if (contact.scene === 'friend') continue
        list.content.push(v.targetId === 'all' ? '<qqbot-at-everyone />' : `<qqbot-at-user id="${v.targetId}" />`)
      }

      if (v.type === 'image') {
        list.image.push(v.file)
        continue
      }

      if (v.type === 'pasmsg') {
        if (v.source === 'event') list.pasmsg.type = 'event'
        // 检查是否有 is_wakeup 属性（仅好友场景支持）
        const pasmsgWithWakeup = v as any
        if (pasmsgWithWakeup.is_wakeup && contact.scene === 'friend') {
          list.pasmsg.is_wakeup = true
          list.pasmsg.msg_id = '' // is_wakeup 与 msg_id/event_id 互斥
        } else {
          list.pasmsg.msg_id = v.id
        }
        continue
      }

      if (v.type === 'keyboard') {
        list.keyboard.push(v)
        continue
      }

      if (v.type === 'button') {
        list.button.push(v)
        continue
      }

      if (v.type === 'markdown') {
        list.markdown.push(v)
        continue
      }

      if (v.type === 'markdownTpl') {
        list.markdownTpl.push(v)
        continue
      }

      if (v.type === 'video' || v.type === 'record') {
        let url: string
        if (v.file.startsWith('http')) {
          url = v.file
        } else {
          const data = await fileToUrl(v.type, v.file, `${v.type}.${v.type === 'record' ? 'mp3' : 'mp4'}`)
          url = data.url
        }
        const res = await this.super.uploadMedia(target, contact.peer, v.type, url, false)
        list.list.push(this.super.QQdMsgOptions('media', res.file_info))
        continue
      }

      this.logger('debug', `[QQBot][${v.type}] 不支持发送的消息类型`)
    }

    /** 处理被动消息 - 为每条消息生成唯一的 msg_seq（默认自动递增） */
    let msgSeqCounter = 0
    const pasmsg = (() => {
      // 如果设置了 is_wakeup 且是好友场景，直接返回设置 is_wakeup 的函数
      if (list.pasmsg.is_wakeup && contact.scene === 'friend') {
        return (item: SendQQMsg) => {
          item.is_wakeup = true
        }
      }

      // 如果没有 msg_id，使用时间戳 + 计数器确保唯一性
      if (!list.pasmsg.msg_id) {
        const baseSeq = Date.now() % 0xFFFFFFFF
        return (item: SendQQMsg) => {
          item.msg_seq = baseSeq + msgSeqCounter++
        }
      }

      // 有 msg_id 的情况，自动递增 msg_seq
      const baseSeq = list.pasmsg.msg_seq
      return (item: SendQQMsg) => {
        const currentSeq = baseSeq + msgSeqCounter++
        if (list.pasmsg.type === 'msg') {
          item.msg_seq = currentSeq
          item.msg_id = list.pasmsg.msg_id
        } else {
          item.msg_seq = currentSeq
          item.event_id = list.pasmsg.msg_id
        }
      }
    })()

    /** 发送消息 */
    const send = (() => {
      if (contact.scene === 'friend') {
        return (peer: string, item: SendQQMsg) => this.super.sendFriendMsg(peer, item)
      }

      return (peer: string, item: SendQQMsg) => this.super.sendGroupMsg(peer, item)
    })()

    return this.markdown('qq', this, list, contact, pasmsg, send)
  }

  /**
   * 发送频道消息
   * @param contact 联系人
   * @param elements 消息元素
   * @param retryCount 重试次数
   */
  async sendGuildMsg (
    contact: Contact<'guild' | 'direct'>,
    elements: Array<ElementTypes>,
    retryCount?: number
  ): Promise<SendMsgResults> {
    const list = this.initList('guild')

    for (const v of elements) {
      if (v.type === 'text') {
        const { text, buttons } = textToButton(v.text, contact.scene === 'direct')
        list.content.push(text)
        if (buttons) list.button.push(...buttons)
        continue
      }

      if (v.type === 'image') {
        list.image.push(v.file)
        continue
      }

      if (v.type === 'at') {
        if (contact.scene === 'guild') {
          list.content.push(v.targetId === 'all' ? '<qqbot-at-everyone />' : `<qqbot-at-user id="${v.targetId}" />`)
        }
        continue
      }

      if (v.type === 'pasmsg') {
        if (v.source === 'event') list.pasmsg.type = 'event'
        list.pasmsg.msg_id = v.id
        continue
      }

      if (v.type === 'reply') {
        list.reply.message_id = v.messageId
        continue
      }

      if (v.type === 'face') {
        list.content.push(`<emoji:${v.id}>`)
        continue
      }

      if (v.type === 'keyboard') {
        list.keyboard.push(v)
        continue
      }

      if (v.type === 'button') {
        list.button.push(v)
        continue
      }

      if (v.type === 'markdown') {
        list.markdown.push(v)
        continue
      }

      if (v.type === 'markdownTpl') {
        list.markdownTpl.push(v)
        continue
      }

      this.logger('debug', `[QQBot][${v.type}] 不支持发送的消息类型`)
    }

    /** 发送消息 */
    const send = (() => {
      if (contact.scene === 'guild') {
        return (
          peer: string,
          subPeer: string,
          item: SendGuildMsg | FormData
        ) => this.super.sendChannelMsg(subPeer, item)
      }

      return (
        peer: string,
        subPeer: string,
        item: SendGuildMsg | FormData
      ) => this.super.sendDmsMsg(peer, item)
    })()

    /** 处理被动消息 */
    const pasmsg = (() => {
      if (!list.pasmsg.msg_id) return () => ''

      if (list.pasmsg.type === 'msg') {
        return (item: SendGuildMsg | FormData) => {
          if (item instanceof FormData) {
            return item.append('msg_id', list.pasmsg.msg_id)
          }

          item.msg_id = list.pasmsg.msg_id
        }
      }

      return (item: SendGuildMsg | FormData) => {
        if (item instanceof FormData) {
          return item.append('event_id', list.pasmsg.msg_id)
        }

        item.event_id = list.pasmsg.msg_id
      }
    })()

    return this.markdown('guild', this, list, contact, pasmsg, send)
  }
}
