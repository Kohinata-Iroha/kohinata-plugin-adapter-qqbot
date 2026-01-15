import FormData from 'form-data'
import { handleUrl, qrs } from '@/utils/common'
import { common, fileToUrl } from 'node-karin'
import { AdapterQQBot } from '@/core/adapter/adapter'
import { SendGuildMsg, SendQQMsg } from '@/core/api/types'
import type { Contact, ElementTypes, Message, SendMsgResults } from 'node-karin'
import type { QQBotConfig } from '@/types/config'
import type { QQBotApi } from '@/core/api'

/**
 * 检测图片类型并返回文件名和 Content-Type
 * @param buffer 图片 buffer
 * @param filePath 文件路径（可选，用于提取扩展名）
 * @returns 文件名和 Content-Type
 */
function detectImageType (buffer: Buffer, filePath?: string): { filename: string, contentType: string } {
  // 优先从文件路径提取扩展名
  if (filePath) {
    const ext = filePath.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp)$/)?.[1]
    if (ext) {
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp'
      }
      return {
        filename: `image.${ext}`,
        contentType: mimeMap[ext] || 'image/jpeg'
      }
    }
  }

  // 根据 buffer 的魔数检测图片类型
  const header = buffer.slice(0, 12)

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) {
    return { filename: 'image.png', contentType: 'image/png' }
  }

  // JPEG: FF D8 FF
  if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) {
    return { filename: 'image.jpg', contentType: 'image/jpeg' }
  }

  // GIF: 47 49 46 38
  if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x38) {
    return { filename: 'image.gif', contentType: 'image/gif' }
  }

  // WebP: 52 49 46 46 ... 57 45 42 50
  if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
    header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) {
    return { filename: 'image.webp', contentType: 'image/webp' }
  }

  // 默认返回 JPEG
  return { filename: 'image.jpg', contentType: 'image/jpeg' }
}

/** 正常发送消息 */
export class AdapterQQBotNormal extends AdapterQQBot {
  _config: QQBotConfig
  constructor (QQBot: QQBotApi, config: QQBotConfig) {
    super(QQBot)
    this._config = config
  }

  async srcReply (e: Message, elements: ElementTypes[]) {
    return this.sendMsg(e.contact, elements)
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
   * @returns 处理后的文本和二维码 二维码为不带`base64://`的字符串，如果多个二维码合并失败，返回第一个二维码
   */
  async hendleText (text: string): Promise<{ text: string, qr: string | null, qrs?: string[] }> {
    // 使用配置的白名单过滤 URL
    const exclude = this._config?.exclude || []
    const urls = handleUrl(text, exclude)
    if (!urls.length) return { text, qr: null }

    urls.forEach((url) => {
      text = text.replace(new RegExp(url, 'g'), '[请扫码查看]')
    })

    const list = await qrs(urls)

    // 单个二维码直接返回
    if (list.length === 1) return { text, qr: list[0] }

    // 多个二维码尝试合并，失败则返回所有二维码列表
    try {
      const result = await common.mergeImage(list, 3)
      return { text, qr: result.base64 }
    } catch (error) {
      // 合并失败（可能是 ffmpeg 不可用），返回所有二维码列表，让调用方逐个发送
      this.logger('warn', `二维码合并失败，将发送 ${list.length} 个单独的二维码:`, error)
      return { text, qr: null, qrs: list }
    }
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
        const { text, qr, qrs } = await this.hendleText(v.text)
        list.content.push(text)
        if (qr) {
          list.image.push(qr)
        } else if (qrs && qrs.length > 0) {
          // 合并失败，逐个添加二维码
          qrs.forEach((qrItem) => {
            list.image.push(qrItem)
          })
        }
        continue
      }

      if (v.type === 'image') {
        list.image.push(v.file)
        continue
      }

      if (v.type === 'reply') {
        // QQ C2C/群聊暂未直接支持引用，使用被动消息 msg_id 兼容以避免无意义的告警日志
        if (!list.pasmsg.msg_id) list.pasmsg.msg_id = v.messageId
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

    if (list.content.length) {
      list.list.unshift(this.super.QQdMsgOptions('text', list.content.join('')))
    }

    for (const url of list.image) {
      const base64 = await common.base64(url)
      const result = await this.super.uploadMedia(target, contact.peer, 'image', base64, false)
      list.list.push(this.super.QQdMsgOptions('media', result.file_info))
    }

    /** 处理Markdown、按钮 */
    list.markdownToButton('qq', list)

    /** 返回值 */
    const rawData = this.initSendMsgResults()

    /** 处理被动消息 */
    const pasmsg = (() => {
      // 如果设置了 is_wakeup 且是好友场景，直接返回设置 is_wakeup 的函数
      if (list.pasmsg.is_wakeup && contact.scene === 'friend') {
        return (item: SendQQMsg) => {
          item.is_wakeup = true
        }
      }

      if (!list.pasmsg.msg_id) return () => ''

      list.pasmsg.msg_seq++
      if (list.pasmsg.type === 'msg') {
        return (item: SendQQMsg) => {
          item.msg_seq = list.pasmsg.msg_seq
          item.msg_id = list.pasmsg.msg_id
        }
      }

      return (item: SendQQMsg) => {
        item.msg_seq = list.pasmsg.msg_seq
        item.event_id = list.pasmsg.msg_id
      }
    })()

    /** 发送消息 */
    const send = (() => {
      if (contact.scene === 'friend') {
        return (peer: string, item: SendQQMsg) => this.super.sendFriendMsg(peer, item)
      }

      return (peer: string, item: SendQQMsg) => this.super.sendGroupMsg(peer, item)
    })()

    if (!list.list.length) {
      list.list.push(this.super.QQdMsgOptions('text', '不支持发送的消息类型'))
    }

    for (const item of list.list) {
      pasmsg(item)
      const res = await send(contact.peer, item)
      rawData.rawData.push(res)
    }

    return this.handleResponse(rawData)
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
        const { text, qr, qrs } = await this.hendleText(v.text)
        list.content.push(text)
        if (qr) {
          list.image.push(qr)
        } else if (qrs && qrs.length > 0) {
          // 合并失败，逐个添加二维码
          qrs.forEach((qrItem) => {
            list.image.push(qrItem)
          })
        }
        continue
      }

      if (v.type === 'image') {
        v.file.startsWith('http') ? list.imageUrls.push(v.file) : list.imageFiles.push(v.file)
        continue
      }

      if (v.type === 'at') {
        if (contact.scene === 'guild') list.content.push(v.targetId === 'all' ? '@everyone' : `<@${v.targetId}>`)
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

    /** 情况较为复杂... */
    if (list.content.length) {
      if (list.imageUrls.length) {
        const url = list.imageUrls.shift()
        list.list.unshift(this.super.GuildMsgOptions('text', list.content.join(''), url))
      } else if (list.imageFiles.length) {
        const file = list.imageFiles.shift()!
        const buffer = await common.buffer(file)
        const { filename, contentType } = detectImageType(buffer, file)
        const formData = new FormData()
        formData.append('content', list.content.join(''))
        formData.append('file_image', buffer, {
          filename,
          contentType
        })
        list.list.unshift(formData)
      } else {
        list.list.unshift(this.super.GuildMsgOptions('text', list.content.join('')))
      }
    }

    for (const url of list.imageUrls) {
      list.list.push(this.super.GuildMsgOptions('image', url))
    }

    for (const file of list.imageFiles) {
      const buffer = await common.buffer(file)
      const { filename, contentType } = detectImageType(buffer, file)
      const formData = new FormData()
      formData.append('file_image', buffer, {
        filename,
        contentType
      })
      list.list.push(formData)
    }

    /** 处理Markdown、按钮 */
    list.markdownToButton('guild', list)
    const rawData = this.initSendMsgResults()

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

    if (!list.list.length) {
      list.list.push(this.super.GuildMsgOptions('text', '不支持发送的消息类型'))
    }

    for (const item of list.list) {
      pasmsg(item)
      const res = await send(contact.peer, contact.subPeer, item)
      rawData.rawData.push(res)
    }

    return this.handleResponse(rawData)
  }
}
