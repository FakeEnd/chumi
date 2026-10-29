const zh = {
  'Preparing your meeting space…': '正在准备会议空间…',
  'Chumi cannot find a free local port. Close older Chumi copies and reopen it.': 'Chumi 找不到可用的本地端口。请关闭其他 Chumi 窗口后重新打开。',
  'Another copy of Chumi is running. Close that copy, then reopen this app.': '另一个 Chumi 正在运行。请先关闭它，再重新打开本应用。',
  'Chumi could not start. Details are in the server log.': 'Chumi 未能启动。详情请查看服务日志。',
  'Chumi took too long to start. Details are in the server log.': 'Chumi 启动超时。详情请查看服务日志。',
  'Chumi’s background service stopped ({code}).': 'Chumi 的后台服务已停止（{code}）。',
  'Restart Chumi': '重新启动 Chumi',
  'Restarting Chumi…': '正在重新启动 Chumi…',
  'Chumi will restart automatically. Recording will stay stopped.': 'Chumi 将自动重新启动，录音会保持停止状态。',
  'Chumi restarted. Open your interrupted meeting to continue recording.': 'Chumi 已重新启动。打开中断的会议即可继续录音。',
  'Chumi is ready again.': 'Chumi 已恢复，可以继续使用了。',
  'Save the meeting and close?': '保存会议并关闭？',
  'You can continue recording the next time you open Chumi.': '下次打开 Chumi 可以继续录音。',
  'Keep recording': '继续会议',
  'Save and close': '保存并关闭',
  'Could not open link': '无法打开链接',
  'Unsupported link.': '不支持此链接。',
  'Windows credential encryption is unavailable.': 'Windows 凭据加密不可用。',
  'Press Alt, then choose Chumi → View Logs': '按 Alt 键，然后选择 Chumi → 查看日志',
  'View Logs': '查看日志',
  'Exit': '退出',
  'Edit': '编辑',
  'Undo': '撤销',
  'Redo': '重做',
  'Cut': '剪切',
  'Copy': '复制',
  'Paste': '粘贴',
  'Delete': '删除',
  'Select All': '全选',
  'View': '视图',
  'Reload': '重新加载',
  'Actual Size': '实际大小',
  'Zoom In': '放大',
  'Zoom Out': '缩小',
  'Toggle Full Screen': '切换全屏',
  'Developer Tools': '开发者工具',
  'Window': '窗口',
  'Desktop Pet': '桌宠',
};

function resolveLanguage(preference, system) {
  return preference === 'en' || preference === 'zh' ? preference : String(system).toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
function translate(language, text, vars = {}) {
  return (language === 'zh' ? zh[text] ?? text : text).replace(/\{(\w+)\}/g, (match, key) => key in vars ? String(vars[key]) : match);
}
module.exports = { resolveLanguage, translate };
