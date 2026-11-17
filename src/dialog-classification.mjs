// Ordered by consequences, never by the presence of an OK button.
export function classifyDialog(text, action = '') {
  const value = String(text || '');
  if (/删除|部署|发布|配置|撤销流程|终止流程|delete|deploy|publish|terminate/i.test(value + action)) return 'unknown';
  if (/超时|timeout|服务异常|服务不可用|连接失败|回调失败|HTTP\s*5\d\d/i.test(value)) return 'external-service';
  if (/至少.{0,12}(填写|选择|上传)|编号不存在|批件制作中|不满足|无权限|没有权限|请确认已完成|业务条件/i.test(value)) return 'business-validation';
  if (/格式|正确的.{0,12}(联系|电话|邮箱|日期|证件)|invalid|无效/i.test(value)) return 'format-validation';
  if (/必填|必须填写|未填写|请填写|请上传|请选择|内容完整|required/i.test(value)) return 'required-validation';
  if (/失败|错误|error|failed/i.test(value)) return 'unknown';
  if (/如有其它相关说明，请点击备注|打印提示|调试说明|仅供调试|操作成功|Done successfully/i.test(value)) return 'information';
  if (value.length < 1500 && /提交|通过|确认|完成|退回|重新办理|转.{1,30}/.test(action) &&
      /(?:确认|确定|是否|继续).{0,30}(?:提交|通过|完成|退回|转交|办理)|(?:sure|confirm).{0,30}(?:submit|approve)/i.test(value)) return 'submission-confirmation';
  return 'unknown';
}

export function submissionOutcome(result) {
  const response = result?.responses?.findLast(r => r.endpoint?.endsWith('doAction'));
  if (result?.http >= 500 || response?.http >= 500) return 'external-service';
  if (result?.submitted && response?.errno === 0 && result.http === 200) return 'accepted';
  if (response?.errno !== undefined && response.errno !== 0) return classifyDialog(response.error);
  if (result?.submitted || !result) return 'unknown';
  return result.confirmations?.map(c => c.classification).find(c => /validation$/.test(c)) || 'unknown';
}
