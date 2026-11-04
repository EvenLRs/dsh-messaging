import { createHash } from 'node:crypto'
import { createStaticCard } from './lark-card-layout.js'
// Batch A provider: only verified same-chat quote reads and explicit replies.
// request owns tenant token lookup, generation checks and object->JSON transport.
export function createLarkInteractions({ request, prepare = async () => ({}) }) {
  const error = (code, unknown = false) => ({ ok: false, code, unknown })
  function failure(raw) {
    const code = raw?.json?.code
    if (!raw || !raw.status || raw.timedOut || raw.aborted || raw.status >= 500 || raw.status === 429) return error('delivery_unknown', true)
    if (code === 99991672) return error('permission_denied')
    if (raw.status === 401 || raw.status === 403 || code === 230027) return error('access_denied')
    // An absent/malformed success envelope is not a definite rejection of a
    // dispatched write. The platform may have acted before its reply was lost.
    if (!Number.isInteger(code) || code === 0) return error('delivery_unknown', true)
    if (raw.status === 404 || [230011, 230110, 231003, 231004].includes(code)) return error('not_found_or_recalled')
    if ([230033, 230035, 230036].includes(code)) return error('expired')
    if ([231002, 231008, 230012].includes(code)) return error('access_denied')
    if (code === 231015) return error('conflict')
    if ([230054, 230071, 230072, 231017].includes(code)) return error('unsupported_context')
    return error('platform_rejected')
  }
  function validate(binding, input) {
      const payload = {
        msg_type: binding.interactiveCard ? 'interactive' : 'text',
        content: JSON.stringify(binding.interactiveCard ? createStaticCard(input.text) : { text: input.text }),
        reply_in_thread: input.replyInThread === true, uuid: input.uuid,
      }
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 30 * 1024) return error('invalid_arguments')
      return { ok: true, payload }
  }
  const endpoint = target => '/im/v1/messages/' + encodeURIComponent(target.messageId)
  function validateOperation(binding, target, operation, input) {
    let method, path = endpoint(target), payload
    if (operation === 'message.edit') {
      if (target.messageType === 'static_card' && target.updateMulti === true) {
        method = 'PATCH'; payload = { content: JSON.stringify(createStaticCard(input.text)) }
      } else if (target.messageType === 'text' || target.messageType === 'post') {
        method = 'PUT'; payload = { msg_type: target.messageType, content: JSON.stringify(target.messageType === 'text'
          ? { text: input.text } : { zh_cn: { title: '', content: [[{ tag: 'text', text: input.text }]] } }) }
      } else return error('unsupported_message_type')
    } else if (operation === 'message.recall') method = 'DELETE'
    else if (operation === 'reaction.add') { method = 'POST'; path += '/reactions'; payload = { reaction_type: { emoji_type: input.emoji } } }
    else if (operation === 'reaction.remove') { method = 'DELETE'; path += '/reactions/' + encodeURIComponent(input.reactionId) }
    else return error('unsupported_context')
    if (payload && Buffer.byteLength(JSON.stringify(payload)) > 30 * 1024) return error('invalid_arguments')
    return { ok: true, method, path, payload }
  }
  function validateCard(binding,target,publish,card,uuid) {
    const payload = publish ? {msg_type:'interactive',content:JSON.stringify(card),reply_in_thread:false,uuid} : {content:JSON.stringify(card)}
    if(Buffer.byteLength(JSON.stringify(payload))>30*1024)return error('invalid_arguments')
    return {ok:true,method:publish?'POST':'PATCH',path:endpoint(target)+(publish?'/reply':''),payload}
  }
  async function paged(binding, target, operation, call) {
    const counts = Object.create(null), own = [], identities = new Set(), pageTokens = new Set()
    let token, complete = false, reason = null, lastReadAt = null, pages = 0
    for (; pages < 3; pages++) {
      call.check()
      const suffix = operation === 'read.query' ? '/read_users?user_id_type=open_id&page_size=50' : '/reactions?user_id_type=open_id&page_size=50'
      const raw = await request(binding, 'GET', endpoint(target) + suffix + (token ? '&page_token=' + encodeURIComponent(token) : ''), undefined, call)
      if (!raw?.ok || raw.json?.code !== 0) {
        const problem = failure(raw)
        if (!pages) return error(problem.unknown ? 'unavailable' : problem.code)
        reason = problem.unknown ? 'unavailable' : problem.code; break
      }
      const data = raw.json.data
      if (!data || !Array.isArray(data.items) || typeof data.has_more !== 'boolean') {
        if (!pages) return error('unavailable')
        reason = 'malformed_page'; break
      }
      for (const item of data.items.slice(0, 50)) {
        if (operation === 'read.query') {
          if (typeof item.user_id !== 'string' || item.user_id_type !== 'open_id') { reason = 'malformed_page'; continue }
          // Raw ids are neither returned nor retained after this bounded request.
          identities.add(createHash('sha256').update(binding.appId + '\0' + item.user_id).digest('hex'))
          const time = Number(item.timestamp)
          if (Number.isSafeInteger(time) && time >= Date.UTC(2020, 0, 1) && time <= Date.now() + 300000) lastReadAt = Math.max(lastReadAt || 0, time)
        } else {
          const emoji = item.reaction_type?.emoji_type, id = item.reaction_id
          if (typeof emoji !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(emoji) || typeof id !== 'string' || !id || id.length > 512) { reason = 'malformed_page'; continue }
          const opaque = createHash('sha256').update(id).digest('hex')
          if (identities.has(opaque)) continue
          identities.add(opaque); counts[emoji] = (counts[emoji] || 0) + 1
          if (item.operator?.operator_type === 'app' && item.operator.operator_id === binding.appId) own.push({ reactionId: id, emoji })
        }
      }
      if (data.items.length > 50) { reason = 'page_limit'; break }
      if (!data.has_more) { complete = !reason; break }
      if (typeof data.page_token !== 'string' || !data.page_token || data.page_token.length > 4096 || pageTokens.has(data.page_token)) { reason = 'invalid_pagination'; break }
      token = data.page_token; pageTokens.add(token)
    }
    return { ok: true, source: 'api', complete, partial: !complete, pages: Math.min(pages + 1, 3), reason: complete ? null : reason || 'page_limit',
      ...(operation === 'read.query' ? { observedReaders: identities.size, lastReadAt, unread: 'unknown' } : { counts, own }) }
  }
  return {
    validate,
    validateCard,
    async prepareCard(binding,target,publish,card,uuid,call) {
      const checked=validateCard(binding,target,publish,card,uuid);if(!checked.ok)return checked
      call.check();const transport=await prepare(binding,call);call.check();return {...checked,transport}
    },
    async cardWrite(binding,target,publish,call,prepared) {
      const raw=await request(binding,prepared.method,prepared.path,prepared.payload,call,prepared.transport)
      if(!raw?.ok||raw.json?.code!==0)return failure(raw)
      if(!publish)return {ok:true,messageId:target.messageId}
      const data=raw.json.data
      if(!data||typeof data.message_id!=='string'||!data.message_id||data.message_id.length>512||(data.chat_id!==undefined&&data.chat_id!==binding.chatId))return error('delivery_unknown',true)
      return {ok:true,messageId:data.message_id,createTime:data.create_time}
    },
    validateOperation,
    async prepareOperation(binding, target, operation, input, call) {
      const checked = validateOperation(binding, target, operation, input)
      if (!checked.ok) return checked
      call.check(); const transport = await prepare(binding, call); call.check()
      return { ...checked, transport }
    },
    async operate(binding, target, operation, input, call, prepared) {
      const raw = await request(binding, prepared.method, prepared.path, prepared.payload, call, prepared.transport)
      if (!raw?.ok || raw.json?.code !== 0) return failure(raw)
      if (operation === 'reaction.add') {
        const data = raw.json.data, op = data?.operator
        if (!data || typeof data.reaction_id !== 'string' || !data.reaction_id || data.reaction_id.length > 512
          || !op || op.operator_type !== 'app' || op.operator_id !== binding.appId) return error('delivery_unknown', true)
        return { ok: true, messageId: data.reaction_id, reactionId: data.reaction_id }
      }
      return { ok: true, messageId: target.messageId }
    },
    paged,
    async prepare(binding, target, input, call) {
      const checked = validate(binding, input)
      if (!checked.ok) return checked
      call.check()
      const transport = await prepare(binding, call)
      call.check()
      return { ...checked, transport }
    },
    async reply(binding, target, input, call, prepared) {
      const raw = await request(binding, 'POST', '/im/v1/messages/' + encodeURIComponent(target.messageId) + '/reply', prepared.payload, call, prepared.transport)
      if (!raw?.ok || raw.json?.code !== 0) return failure(raw)
      const data = raw.json.data
      // Success without identity is ambiguous, never manufacture a message handle.
      if (!data || typeof data.message_id !== 'string' || !data.message_id || data.message_id.length > 512) return error('delivery_unknown', true)
      if (data.chat_id !== undefined && data.chat_id !== binding.chatId) return error('delivery_unknown', true)
      return { ok: true, messageId: data.message_id, createTime: data.create_time }
    },
    async quote(binding, target, call) {
      // The default IM projection of CardKit 2.0 can be only a client-upgrade
      // notice. Request the documented original-card format on this same
      // authorized message GET; it does not change the target or permissions.
      const raw = await request(binding, 'GET', '/im/v1/messages/' + encodeURIComponent(target.messageId) + '?card_msg_content_type=user_card_content', undefined, call)
      if (!raw?.ok || raw.json?.code !== 0) {
        const failed = failure(raw)
        return error(failed.unknown ? 'unavailable' : failed.code)
      }
      const item = raw.json.data?.items?.[0]
      if (!item || item.message_id !== target.messageId || item.chat_id !== binding.chatId) return error('target_unverified')
      if (item.deleted === true) return error('not_found_or_recalled')
      let content
      try { content = typeof item.body?.content === 'string' ? JSON.parse(item.body.content) : item.body?.content } catch { return error('unavailable') }
      let text, cardTruncated = false
      if (item.msg_type === 'text') text = content?.text
      else if (item.msg_type === 'post') {
        const post = content?.zh_cn || content?.en_us || content
        text = [post?.title, ...(Array.isArray(post?.content) ? post.content.flat().filter(x => ['text', 'a'].includes(x?.tag)).map(x => x.text) : [])].filter(x => typeof x === 'string').join('\n')
      } else if (item.msg_type === 'interactive') {
        // Only traverse the supported render-text keys, not action/value/url
        // properties or opaque card IDs. Inline Markdown URLs/mentions/image
        // keys remain untrusted text; this is not a content sanitizer.
        if (content?.config?.streaming_mode === true) return error('unavailable')
        const pieces = []
        let visited = 0
        function visit(node, depth = 0) {
          if (!node || typeof node !== 'object') return
          if (depth > 12 || ++visited > 512) { cardTruncated = true; return }
          if (Array.isArray(node)) { for (const child of node) visit(child, depth + 1); return }
          if (['plain_text', 'lark_md', 'markdown'].includes(node.tag) && typeof node.content === 'string') pieces.push(node.content)
          if (node.tag === 'text' && typeof node.text === 'string') pieces.push(node.text) // default IM projection
          for (const key of ['text', 'elements', 'body', 'columns']) visit(node[key], depth + 1)
        }
        visit(content?.body || content?.elements)
        // E1's compatibility skeleton has an empty text piece after the notice.
        // Neither blanks nor a title can establish that the body is readable.
        const notice = /^请升级至最新版本客户端[，,]以查看内容[。.!！]?$/u
        const readable = pieces.filter(piece => piece.trim().length > 0 && !notice.test(piece.trim()))
        if (!readable.length) return error('unsupported_message_type')
        if (readable.every(piece => piece.trim() === '…')) return error('unavailable')
        const title = typeof content?.title === 'string' ? content.title : content?.header?.title?.content
        text = [typeof title === 'string' && title.trim().length > 0 && !notice.test(title.trim()) ? title : null, ...readable]
          .filter(piece => typeof piece === 'string').join('\n')
      } else return error('unsupported_message_type')
      if (typeof text !== 'string') return error('unavailable')
      return { ok: true, text: [...text].slice(0, 4096).join(''), truncated: [...text].length > 4096 || cardTruncated, updated: item.updated === true, createTime:item.create_time, messageType:item.msg_type }
    },
  }
}
