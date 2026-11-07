import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {setImmediate} from 'node:timers/promises'
import {createRenderer, h, nextTick} from 'vue'
import {compileScript, parse} from 'vue/compiler-sfc'
import {configData, normalizeConfig} from '../src/js/config.js'

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const apiUrl = moduleUrl(`
    export const state = {config: {}, requests: []}
    export default {
        async post(url, data) {
            state.requests.push({url, data: structuredClone(data)})
            if (url === 'api/config') return {data: structuredClone(state.config)}
            if (url === 'api/setConfig') {
                state.config = structuredClone(data)
                return {message: '已保存'}
            }
            throw new Error('Unexpected API request: ' + url)
        }
    }
`)
const {state} = await import(apiUrl)
const emptyView = moduleUrl('export default {inheritAttrs: false, render: () => null}')
const imports = {
    vue: import.meta.resolve('vue'),
    'js-md5': import.meta.resolve('js-md5'),
    'element-plus': moduleUrl("export const ElText = 'el-text'; export const ElMessage = {success() {}}"),
    '@element-plus/icons-vue': moduleUrl("export const Key = 'key-icon'; export const User = 'user-icon'"),
    '@/js/api.js': apiUrl,
    '@/js/config.js': new URL('../src/js/config.js', import.meta.url).href,
    '@/js/tmdb-i18n.js': new URL('../src/js/tmdb-i18n.js', import.meta.url).href,
    './global.js': moduleUrl("export const base64Encode = () => {throw new Error('Unexpected base64Encode call')}")
}
const elementTags = new Set()

const loadModule = source => moduleUrl(source.replace(/\bfrom\s+(['"])([^'"]+)\1/g, (_, quote, name) => {
    const url = imports[name] ?? (name.endsWith('.vue') ? emptyView : undefined)
    assert.ok(url, `Unexpected import: ${name}`)
    return `from ${JSON.stringify(url)}`
}))

const loadView = (filename) => {
    const source = readFileSync(new URL(`../src/${filename}`, import.meta.url), 'utf8')
    for (const match of source.matchAll(/<(el-[\w-]+)/g)) elementTags.add(match[1])
    const {descriptor, errors} = parse(source, {filename})
    assert.deepEqual(errors, [])
    const {content} = compileScript(descriptor, {id: filename, inlineTemplate: true})
    return loadModule(`const window = {$reLoadList() {}};\n${content}`)
}

imports['@/js/http.js'] = loadModule(readFileSync(new URL('../src/js/http.js', import.meta.url), 'utf8'))
imports['@/view/config/basic/AddView.vue'] = loadView('view/config/basic/AddView.vue')
imports['@/view/config/LoginConfigView.vue'] = loadView('view/config/LoginConfigView.vue')
imports['@/view/config/BasicView.vue'] = loadView('view/config/BasicView.vue')
const {default: ConfigView} = await import(loadView('view/home/ConfigView.vue'))

const createNode = (type, text = '') => ({type, text, props: {}, children: [], parent: null})
const removeNode = (node) => {
    if (!node.parent) return
    const siblings = node.parent.children
    siblings.splice(siblings.indexOf(node), 1)
    node.parent = null
}
const renderer = createRenderer({
    createElement: type => createNode(type),
    createText: text => createNode('text', text),
    createComment: text => createNode('comment', text),
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => {
        node.children.forEach(child => { child.parent = null })
        node.children = []
        node.text = text
    },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    insert(node, parent, anchor) {
        removeNode(node)
        const index = anchor ? parent.children.indexOf(anchor) : parent.children.length
        parent.children.splice(index, 0, node)
        node.parent = parent
    },
    remove: removeNode,
    patchProp: (node, key, previous, value) => { node.props[key] = value }
})

const descendants = node => [node, ...node.children.flatMap(descendants)]
const find = (root, type, props = {}) => {
    const matches = descendants(root).filter(node => node.type === type &&
        Object.entries(props).every(([key, value]) => node.props[key] === value))
    assert.equal(matches.length, 1, `Expected one ${type} ${JSON.stringify(props)}`)
    return matches[0]
}
const controls = (root) => {
    const basic = find(root, 'el-tab-pane', {label: '基本设置'})
    const add = find(basic, 'el-collapse-item', {title: '添加订阅'})
    const offset = find(add, 'el-form-item', {label: '自动偏移类型'})
    const login = find(root, 'el-tab-pane', {label: '登录设置'})
    return {
        offset: find(offset, 'el-select'),
        verifyIp: find(login, 'el-checkbox', {label: '如果IP发生改变登录将失效'})
    }
}
const flush = async () => {
    await setImmediate()
    await nextTick()
}
const mountSettings = async (t, config) => {
    state.config = structuredClone(config)
    state.requests = []
    const root = createNode('root')
    const app = renderer.createApp(ConfigView)
    for (const tag of elementTags) {
        const component = (props, {slots}) => h(tag, props, slots.default?.())
        component.inheritAttrs = false
        app.component(tag, component)
    }
    app.directive('loading', {})
    const instance = app.mount(root)
    t.after(() => app.unmount())
    instance.show()
    await flush()
    return {root, instance}
}
const legacyConfig = () => ({
    login: {username: 'admin', password: ''},
    offset: false,
    titleYear: true,
    loginEffectiveHours: 12,
    replace: true,
    copyMasterToStandby: true,
    notificationConfigList: [{id: 'keep', enabled: true}],
    futureSetting: {enabled: true, values: ['keep']}
})

const assertValues = (root, offsetType, verifyLoginIp) => {
    const {offset, verifyIp} = controls(root)
    assert.equal(offset.props.modelValue, offsetType)
    assert.equal(verifyIp.props.modelValue, verifyLoginIp)
}

const save = async (root) => {
    find(root, 'el-button', {type: 'primary'}).props.onClick()
    await flush()
}

test('uses the backend defaults for the two new config fields', () => {
    assert.equal(configData.offsetType, 'AUTO_OFFSET')
    assert.equal(configData.verifyLoginIp, false)
})

test('fills missing fields without mutating or losing unrelated config', () => {
    const original = legacyConfig()
    const snapshot = structuredClone(original)
    const normalized = normalizeConfig(original)
    assert.deepEqual(normalized, {...snapshot, offsetType: 'AUTO_OFFSET', verifyLoginIp: false})
    assert.deepEqual(original, snapshot)
    assert.notEqual(normalized, original)
})

test('uses defaults for null and undefined fields', () => {
    for (const value of [null, undefined]) {
        assert.deepEqual(normalizeConfig({offsetType: value, verifyLoginIp: value}), {
            offsetType: 'AUTO_OFFSET',
            verifyLoginIp: false
        })
    }
})

test('shows both new controls in their legacy settings panels with exact enum values', async (t) => {
    const {root} = await mountSettings(t, legacyConfig())
    const {offset} = controls(root)
    const options = descendants(offset).filter(node => node.type === 'el-option')
    assert.deepEqual(options.map(({props}) => ({value: props.value, label: props.label})), [
        {value: 'AUTO_OFFSET', label: 'AutoOffset'},
        {value: 'BGM_OFFSET', label: 'BgmOffset'}
    ])
    assertValues(root, 'AUTO_OFFSET', false)
    assert.deepEqual(state.requests, [{url: 'api/config', data: undefined}])
    assert.equal(find(root, 'el-dialog').props.modelValue, true)
})

for (const offsetType of ['AUTO_OFFSET', 'BGM_OFFSET']) {
    for (const verifyLoginIp of [false, true]) {
        test(`preserves and displays server config ${offsetType} / verifyLoginIp=${verifyLoginIp}`, async (t) => {
            const original = {...legacyConfig(), offsetType, verifyLoginIp}
            assert.deepEqual(normalizeConfig(original), original)
            const {root} = await mountSettings(t, original)
            assertValues(root, offsetType, verifyLoginIp)
            assert.deepEqual(state.config, original)
        })
    }
}

for (const initial of [
    {offsetType: 'AUTO_OFFSET', verifyLoginIp: false},
    {offsetType: 'BGM_OFFSET', verifyLoginIp: true}
]) {
    test(`edits, saves and reloads config starting from ${initial.offsetType}`, async (t) => {
        const original = {...legacyConfig(), ...initial}
        const expected = {
            ...original,
            offsetType: initial.offsetType === 'AUTO_OFFSET' ? 'BGM_OFFSET' : 'AUTO_OFFSET',
            verifyLoginIp: !initial.verifyLoginIp
        }
        const {root, instance} = await mountSettings(t, original)
        const {offset, verifyIp} = controls(root)
        offset.props['onUpdate:modelValue'](expected.offsetType)
        verifyIp.props['onUpdate:modelValue'](expected.verifyLoginIp)
        await nextTick()
        assertValues(root, expected.offsetType, expected.verifyLoginIp)
        assert.deepEqual(state.config, original)
        await save(root)
        assert.deepEqual(state.requests, [
            {url: 'api/config', data: undefined},
            {url: 'api/setConfig', data: expected}
        ])
        assert.equal(find(root, 'el-dialog').props.modelValue, false)
        instance.show()
        await flush()
        assert.equal(state.requests.at(-1).url, 'api/config')
        assertValues(root, expected.offsetType, expected.verifyLoginIp)
        assert.deepEqual(state.config, expected)
    })
}

test('saves and reloads defaults when the backend omits both fields', async (t) => {
    const original = legacyConfig()
    const {root, instance} = await mountSettings(t, original)
    await save(root)
    assert.deepEqual(state.requests.at(-1), {
        url: 'api/setConfig',
        data: {...original, offsetType: 'AUTO_OFFSET', verifyLoginIp: false}
    })
    instance.show()
    await flush()
    assertValues(root, 'AUTO_OFFSET', false)
})

test('fresh loads use defaults rather than retaining previous field values', async (t) => {
    const {root, instance} = await mountSettings(t, {
        ...legacyConfig(), offsetType: 'BGM_OFFSET', verifyLoginIp: true
    })
    assertValues(root, 'BGM_OFFSET', true)
    state.config = legacyConfig()
    instance.show()
    await flush()
    assertValues(root, 'AUTO_OFFSET', false)
})
