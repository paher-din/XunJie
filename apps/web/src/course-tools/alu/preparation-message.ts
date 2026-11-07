const preparationIssue: Record<string, string> = {
  'resource-missing': '实验资源暂时无法读取，可在连接恢复后重试。',
  'resource-corrupt': '实验资源校验不一致，未启用这份资源，请重试取得原版本。',
  'protocol-unsupported': '当前产品不支持这份运行版本或操作，请更新兼容产品后重试。',
  'device-feature-missing': '当前浏览器缺少实验所需能力，请使用支持的桌面 Chrome。',
  'storage-unavailable': '浏览器本机存储不可用，未启用实验；已有作品和记录仍保留。',
  'self-test-interrupted': '实验准备已中断或超时，可按原准备身份继续。',
  'self-test-failed': '工具链自检未通过，已有作品和记录仍保留，可查看详情后重试。',
}

/** Formatting only: each runtime version retains its own preparation and entry lifecycle. */
export function preparationMessage(result: { status: string; reason?: string;
  diagnostics: readonly { stage: string; detail: string }[] }) {
  const quota = result.reason === 'storage-unavailable' && result.diagnostics.some(item => /quota/i.test(item.detail))
  return {
    note: result.status === 'ready' ? '' : quota
      ? '浏览器存储空间不足，未启用实验。请先保护或导出已有作品，再释放空间后重试。'
      : preparationIssue[result.reason ?? ''] ?? '实验能力尚未确认，可查看准备详情后重试。',
    details: result.diagnostics.map(item => `${item.stage}：${item.detail}`).join('\n'),
  }
}
