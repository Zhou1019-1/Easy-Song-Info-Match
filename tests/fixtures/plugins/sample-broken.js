/**
 * @name 故障示例音源
 * @description 用来验证宿主沙箱：① 加载即抛错 ② 函数死循环（超时熔断）
 * @version 1.0.0
 * @author someone
 */

// ① 加载即抛错：验证插件异常不会拖垮宿主
throw new Error('示例音源故意在加载时抛错：boom')

// ② 死循环：把上面那行 throw 注释掉后本段才会生效，
//    用来验证「调用超时熔断」——宿主必须超时后返回错误，而不是被插件拖死。
module.exports = {
  name: '故障示例音源',
  version: '1.0.0',
  qualitys: ['128k'],
  sources: { kw: { name: '酷我' } },
  musicSearch() {
    return { list: [], total: 0, limit: 0, page: 1 }
  },
  musicUrl() {
    while (true) {
      // 故意死循环
    }
  }
}
