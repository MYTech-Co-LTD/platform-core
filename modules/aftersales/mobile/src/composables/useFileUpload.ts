/**
 * 文件上传相关逻辑（M3b-2：从 wuji-2 搬入后**适配返回值**）
 *
 * 与源侧的**唯一**差异是「上传回了什么」：源侧的 `uploadFile/uploadImage` 回**可读 url**，
 * 而域侧走**预签名直传**（字节不过平台，spec §2.3）——shim 回的是 `{id, objectKey}`，
 * 那串预签名 **PUT** 地址不是可读地址（要 GET 得另签）。所以页面需要的两样东西改由本地持有：
 *   · `previewUrl` —— `URL.createObjectURL(file)` 的**本地 blob**，提交前展示用；
 *   · `attachmentId` —— 服务端预签名时给的行 id，提交时作为 `attachmentIds` 认领（spec §2.3）。
 *
 * ⚠️ 因此 `previewUrl` 是**必须 revoke 的对象 URL**：源侧在上传成功后 revoke（它的 url 已换成
 * 远端地址），这边**不能** revoke——预览全靠它；改到 `removeAttachment` / `clearAttachments`
 * 里 revoke，否则每次上传都漏一个 blob。
 */

import { ref } from 'vue'
import { Message } from '@wujibase/wuji'
import { uploadFile, uploadImage } from '@wujibase/wuji-upload'
import dayjs from 'dayjs'
import type { IAttachment } from '@/types/afterSalesWorkOrder'

export type { IAttachment }

/**
 * 附件行 + **本地稳定 id**（F1）。
 *
 * `IAttachment` 的超集，只在 `useFileUpload` 内部用（对外仍导出 `IAttachment`，页面按它渲染）。
 * 为什么必须有它：`IAttachment.index` 是**上传开始那一刻**的就位下标，而 `removeAttachment`
 * 会 `splice` ⇒ 下单成功前它随时可能指向**别人**或指向**空位**。回写要是跟着它走，就会
 * 「复活已删除的行」或「同一文件长出僵尸 + 重复两条」（评审 F1 的两个实测场景）。
 * `localId` 自 `addAttachment` 起不变，是回写的唯一定位依据。
 */
export interface LocalAttachment extends IAttachment {
  localId: string
}

/**
 * 文件上传 hook
 */
export function useFileUpload() {
  const isUploading = ref(false)
  const attachments = ref<LocalAttachment[]>([])

  /** 按**本地 id** 定位（F1）：找不到 = 这行已被删除 ⇒ 调用方丢弃结果，不复活。 */
  const indexByLocalId = (localId: string) => attachments.value.findIndex((a) => a.localId === localId)

  /**
   * 上传单个文件（带进度）
   *
   * 返回 `<IAttachment 去掉 previewUrl>`：本地 blob 由 `addAttachment` 持有（占位对象里那个），
   * 这里造不出来也不该造 —— 签名如实写出来，省得在返回值里塞一个空的 `previewUrl` 占位。
   */
  const uploadSingleFile = async (
    file: File,
    onProgress?: (progress: number) => void
  ): Promise<Omit<IAttachment, 'previewUrl'>> => {
    // 按日期组织文件夹：after-sales/temp/YYYY/MM/DD/
    // ⚠️ 这条路径**不再有消费方**：对象 key 由服务端在预签名时按 `objectKeyFor(org, clientRequestId)`
    //    生成（spec §2.3），shim 也刻意忽略它。保留形参/拼装是让调用点与源侧同形。
    const now = dayjs()
    const year = now.format('YYYY')
    const month = now.format('MM')
    const day = now.format('DD')
    const timestamp = Date.now()
    const randomStr = Math.random().toString(36).substring(2, 8)

    // 生成临时文件路径
    const folderPath = `after-sales/temp/${year}/${month}/${day}`

    // 判断文件类型（优先通过 MIME 类型判断）
    let fileType: 'image' | 'video'

    if (file.type.startsWith('image/')) {
      fileType = 'image'
    } else if (file.type.startsWith('video/')) {
      fileType = 'video'
    } else {
      // 通过扩展名判断
      const imageExtensions = /\.(jpg|jpeg|png|gif|webp|bmp)$/i
      const videoExtensions = /\.(mp4|mov|avi|mkv|webm|flv|wmv|m4v|3gp)$/i

      if (imageExtensions.test(file.name)) {
        fileType = 'image'
      } else if (videoExtensions.test(file.name)) {
        fileType = 'video'
      } else {
        // 默认作为视频处理
        fileType = 'video'
      }
    }

    // 检查文件大小（限制为 2G）
    const maxFileSize = 2 * 1024 * 1024 * 1024 // 2G
    if (file.size > maxFileSize) {
      Message.warning(`文件大小超过限制 (${(file.size / 1024 / 1024 / 1024).toFixed(2)}GB > 2GB)，请压缩后再上传`)
      throw new Error(`文件大小超过限制 (2GB)`)
    }

    try {
      // 获取文件扩展名
      const fileExt = file.name.substring(file.name.lastIndexOf('.')) || ''
      // 生成临时文件名：时间戳_随机字符串.扩展名
      const uniqueFileName = `temp_${timestamp}_${randomStr}${fileExt}`
      const uniqueFilePath = `${folderPath}/${uniqueFileName}`

      // 服务端预签名时给的行 id（提交时认领用）
      let attachmentId: number | null = null

      const uploadFn = fileType === 'image' ? uploadImage : uploadFile

      if (onProgress) {
        // 模拟进度显示（因为 uploadFile/uploadImage 不支持进度回调）
        let progress = 0
        let uploading = true
        const progressInterval = setInterval(() => {
          if (progress < 95 && uploading) {
            progress += Math.random() * 15
            if (progress > 95) progress = 95
            onProgress(Math.round(progress))
          }
        }, 200)

        try {
          const result = await uploadFn(file as File, uniqueFilePath)
          uploading = false
          clearInterval(progressInterval)
          attachmentId = result.id
          // 上传完成，设置为100%
          onProgress(100)
        } catch (error: any) {
          uploading = false
          clearInterval(progressInterval)
          throw error
        }
      } else {
        const result = await uploadFn(file as File, uniqueFilePath)
        attachmentId = result.id
      }

      return {
        type: fileType,
        attachmentId,
        name: file.name,
        size: file.size,
        originalName: uniqueFileName,
        index: attachments.value.length,
        uploadStatus: 'completed',
        uploadProgress: 100,
      }
    } catch (error: any) {
      console.error('[上传文件] 发生错误:', error)
      Message.error(`文件上传失败: ${error?.message || '未知错误'}`)
      throw error
    }
  }

  /**
   * 添加附件
   *
   * ⚠️ 三处回写（进度 / 成功 / 失败）**一律按 `localId` 定位，不按下标**——删除按钮在上传中
   * **可点**（提交页的删除按钮无 `v-if`），而 `removeAttachment` 会 `splice`，上传开始时记下的
   * 下标当场失效。按下标写的两个实测症状（评审 F1）：
   *   A 删掉**正在上传**的那条 ⇒ 它在上传成功后**复活**成 completed，且 `previewUrl` 已被
   *     `revokeObjectURL` ⇒ 缩略图是坏的，还被计进提交；
   *   B 删掉**前面**的条目 ⇒ 数组左移，写回落到空位 ⇒ 同一文件两条：一条永远 uploading、
   *     一条 completed。
   */
  const addAttachment = async (file: File, index?: number): Promise<LocalAttachment> => {
    const localId = crypto.randomUUID()

    // 先创建一个占位附件，显示上传中状态
    const fileType = file.type.startsWith('image/') ? 'image' : 'video'
    const placeholder: LocalAttachment = {
      localId,
      type: fileType,
      previewUrl: URL.createObjectURL(file), // 创建本地预览
      attachmentId: null,
      name: file.name,
      size: file.size,
      originalName: file.name,
      index: index ?? attachments.value.length,
      uploadStatus: 'uploading',
      uploadProgress: 0,
    }

    // 添加到列表
    attachments.value.push(placeholder)

    try {
      // 执行上传，并更新进度
      const attachment = await uploadSingleFile(file, (progress) => {
        // 进度也按 id 回写：按下标的话，上传中删掉前面的行会让进度打到**别人**身上
        const at = indexByLocalId(localId)
        if (at !== -1) {
          attachments.value[at].uploadProgress = progress
          if (progress === 100) {
            attachments.value[at].uploadStatus = 'completed'
          }
        }
      })

      // 上传完成，更新附件信息
      // ⚠️ `previewUrl` 取自占位对象：本地 blob 是**唯一**的预览源（域侧没有可读 url），
      //    不能像源侧那样在成功后 revoke 掉它。
      const at = indexByLocalId(localId)
      if (at === -1) {
        // 这行在上传途中被删掉了 ⇒ **丢弃结果，不复活**（对象已经上云，但认领与否是提交页的事；
        // 就地写回等于把用户删掉的附件塞回列表，而且它的 previewUrl 已经 revoke 过）。
        return { ...attachment, localId, previewUrl: placeholder.previewUrl, index: placeholder.index }
      }
      attachments.value[at] = {
        ...attachment,
        localId,
        previewUrl: placeholder.previewUrl,
        index: placeholder.index,
        uploadStatus: 'completed',
        uploadProgress: 100,
      }

      return attachments.value[at]
    } catch (error) {
      // 上传失败，更新状态
      const at = indexByLocalId(localId)
      if (at !== -1) {
        attachments.value[at].uploadStatus = 'failed'
        attachments.value[at].uploadProgress = 0
      }
      throw error
    }
  }

  /**
   * 删除附件
   */
  const removeAttachment = (index: number) => {
    // 注意：由于 @wujibase/wuji-upload 模块没有提供 deleteFile 函数
    // 对象存储里的对象无法删除（服务端按 clientRequestId 归属，交给它的清理策略）
    const [removed] = attachments.value.splice(index, 1)
    // 本地 blob 要自己 revoke（源侧没有这一步：它的 url 是远端地址，没有本地对象要释放）
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
  }

  /**
   * 清空附件列表
   */
  const clearAttachments = () => {
    // 与 removeAttachment 同理：清空也必须逐个 revoke，否则每次清空漏一批 blob
    attachments.value.forEach((a) => {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    })
    attachments.value = []
  }

  return {
    isUploading,
    attachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
  }
}
