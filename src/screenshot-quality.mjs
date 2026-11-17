export function screenshotValue(image, page = {}) {
  const reject = (category, reason) => ({category, eligible:false, reason});
  if (image.sourceVariant === 'original') return reject('E','内部原始证据，不用于文档');
  if (/Required request parameter|CDP.*error|ERR_CONNECTION|模拟登录异常/i.test(page.errorText || image.errorText || '')) return reject('D','调试或请求错误');
  if (image.category === 'page-segment') return reject('E','旧滚动视口分段，未经完整内容核验');
  if (image.width < 600 || image.height < 45) return reject('E','分辨率不足');
  if (page.obscured || image.obscured) return reject('E','存在遮挡');
  if (!image.nodeId && !page.nodeId) return reject('E','未关联业务节点');
  if (image.category === 'full-page') {
    if (!page.complete || !page.businessContent) return reject('E','完整性或有效业务内容未核实');
    return {category:'A',eligible:true,reason:'完整业务表单区域，布局测量已核对'};
  }
  if (image.category === 'validation') return image.rule ? {category:'C',eligible:true,reason:image.rule} : reject('E','未关联业务规则');
  if (image.category === 'action-buttons' && !image.labels?.length) return reject('E','未识别实际业务按钮');
  if (!image.parentImage && !image.reviewed && image.detection !== 'live-full-page-bottom-crop') {
    return reject('E','未核实局部图来源');
  }
  return {category:'B',eligible:true,reason:image.title || image.purpose || '已关联业务局部证据'};
}

export function eligibleScreenshot(image) { return image.quality?.eligible === true && ['A','B','C'].includes(image.quality.category); }
