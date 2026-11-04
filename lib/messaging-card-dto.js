// Deliberately finite neutral DTO. No arbitrary JSON, URLs, tools or commands.
const object = x => x && typeof x === 'object' && !Array.isArray(x)
const keys = (x, allowed) => object(x) && Object.keys(x).every(k => allowed.includes(k))
const string = (x, max) => typeof x === 'string' && x.length <= max && x.trim().length > 0 && Buffer.byteLength(x) <= max && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(x)
const id = x => typeof x === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,15}$/.test(x)
export function validateCardDto(dto) {
  if (!keys(dto, ['title','text','fields','choices']) || (!string(dto.title,200) || [...dto.title].length>100) || !string(dto.text,4000)) return false
  const fields = dto.fields ?? [], choices = dto.choices ?? []
  if (!Array.isArray(fields) || fields.length > 8 || !Array.isArray(choices) || choices.length > 6 || (!fields.length && !choices.length)) return false
  const names = new Set(['submit','cancel','interaction_form',...choices.map(c=>'c_'+c?.id)])
  for (const f of fields) {
    if (!keys(f,['id','label','type','required','max_length','enum']) || !id(f.id) || names.has(f.id) || (!string(f.label,200) || [...f.label].length>100) || !['text','multiline'].includes(f.type)
      || (f.required !== undefined && typeof f.required !== 'boolean') || (f.max_length !== undefined && (!Number.isInteger(f.max_length) || f.max_length < 1 || f.max_length > 1000))) return false
    if (f.enum !== undefined && (!Array.isArray(f.enum) || !f.enum.length || f.enum.length > 8 || new Set(f.enum).size !== f.enum.length || f.enum.some(v => !string(v,200) || [...v].length > (f.max_length ?? 256)))) return false
    names.add(f.id)
  }
  const ids = new Set()
  for (const c of choices) { if (!keys(c,['id','label']) || !id(c.id) || ids.has(c.id) || (!string(c.label,200) || [...c.label].length>100)) return false; ids.add(c.id) }
  return Buffer.byteLength(JSON.stringify(dto)) <= 12000
}
export function cardInput(dto, action, choice, form) {
  if (!['submit','choice','cancel'].includes(action)) return null
  if (action === 'submit' && !(dto.fields || []).length) return null
  if (action === 'choice' && !dto.choices?.some(c => c.id === choice)) return null
  if (action !== 'choice' && choice !== undefined) return null
  if (action === 'cancel') return form === undefined || (object(form) && Object.keys(form).length === 0) ? { action: 'cancel' } : null
  const values = form ?? {}
  if (!object(values) || Object.keys(values).some(k => !(dto.fields || []).some(f => f.id === k))) return null
  const safe = Object.create(null)
  for (const f of dto.fields || []) {
    const value = Object.hasOwn(values,f.id) ? values[f.id] : ''
    if (typeof value !== 'string' || value.length > 2 * (f.max_length ?? 256) || [...value].length > (f.max_length ?? 256) || Buffer.byteLength(value) > 4000
      || (f.required && !value.trim()) || (value && f.enum && !f.enum.includes(value))
      || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return null
    safe[f.id] = value
  }
  const result = { action, ...(choice ? { choice } : {}), fields: safe }
  return Buffer.byteLength(JSON.stringify(result)) <= 12000 ? result : null
}
export function renderInteractionCard(dto, identity) {
  const plain = content => ({ tag:'plain_text',content })
  const button = (name,label,action,choice,submit=false) => ({tag:'button',name,type:action==='cancel'?'default':'primary',text:plain(label),
    ...(submit?{form_action_type:'submit'}:{}),behaviors:[{type:'callback',value:{workflow:identity.ref,nonce:identity.nonce,version:identity.version,action,...(choice?{choice}:{})}}]})
  const fields = (dto.fields || []).map(f => ({tag:'input',name:f.id,input_type:f.type==='multiline'?'multiline_text':'text',required:f.required===true,max_length:f.max_length??256,
    label:plain(f.label),...(f.enum?{placeholder:plain([...f.enum.join(' / ')].slice(0,100).join(''))}:{})}))
  const choices = (dto.choices || []).map(c => button('c_'+c.id,c.label,'choice',c.id,true))
  return {schema:'2.0',config:{update_multi:true},header:{title:plain(dto.title)},body:{elements:[
    {tag:'div',text:plain(dto.text)},
    {tag:'form',name:'interaction_form',elements:[...fields,...choices,...(fields.length?[button('submit','提交','submit',undefined,true)]:[])]},
    button('cancel','取消','cancel'),
  ]}}
}
const textSchema={type:'string'}
export const CARD_DTO_SCHEMA={type:'object',properties:{title:textSchema,text:textSchema,
  fields:{type:'array',description:'At most 8 fields; enforced before dispatch.',items:{type:'object',properties:{id:{type:'string',description:'Letter followed by up to 15 ASCII letters/digits/underscores; checked before dispatch.'},label:textSchema,type:{type:'string',enum:['text','multiline']},required:{type:'boolean'},max_length:{type:'integer',description:'Integer 1..1000, default 256; enforced before dispatch.'},enum:{type:'array',description:'1..8 unique allowed strings; enforced before dispatch.',items:textSchema}},required:['id','label','type'],additionalProperties:false}},
  choices:{type:'array',description:'At most 6 choices; enforced before dispatch.',items:{type:'object',properties:{id:{type:'string',description:'Letter followed by up to 15 ASCII letters/digits/underscores; checked before dispatch.'},label:textSchema},required:['id','label'],additionalProperties:false}}},required:['title','text'],additionalProperties:false}
