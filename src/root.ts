import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'node:fs'

/** 当前文件的绝对路径 */
const filePath = fileURLToPath(import.meta.url)
/** 插件包绝对路径 */
const dirPath = path.resolve(filePath, '../..')
/** 插件包的名称 */
const basename = (() => {
  try {
    const pkgPath = path.resolve(dirPath, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.name || path.basename(dirPath)
  } catch {
    return path.basename(dirPath)
  }
})()

export { dirPath, basename }
