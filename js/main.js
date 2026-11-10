const WORKFLOW_EDITOR_LOAD_ERROR = 'Workflow 编辑器脚本未加载，请刷新页面或检查部署资源';

function createEmptyWorkflowGraph() {
    return { nodes: [], edges: [], warnings: [WORKFLOW_EDITOR_LOAD_ERROR] };
}

const WorkflowEditor = window.WorkflowEditor || {
    deepClone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    },
    normalizeEditor(editor) {
        const value = editor && typeof editor === 'object' ? editor : {};
        return {
            profile: String(value.profile || ''),
            roles: value.roles && typeof value.roles === 'object' ? value.roles : {},
            parameterBindings: Array.isArray(value.parameterBindings) ? value.parameterBindings : []
        };
    },
    parse() {
        return createEmptyWorkflowGraph();
    },
    validateProfile() {
        return { valid: false, errors: [WORKFLOW_EDITOR_LOAD_ERROR] };
    },
    mergeParameterBindings() {
        return [];
    },
    getBindingForInput() {
        return null;
    },
    inferControl(value) {
        if (typeof value === 'number') return 'number';
        if (typeof value === 'boolean') return 'checkbox';
        return 'text';
    },
    readManagedLoras() {
        return [];
    },
    setInput() {
        throw new Error(WORKFLOW_EDITOR_LOAD_ERROR);
    },
    exposeInput() {
        throw new Error(WORKFLOW_EDITOR_LOAD_ERROR);
    },
    removeBinding() {
        throw new Error(WORKFLOW_EDITOR_LOAD_ERROR);
    },
    syncLoraChain() {
        throw new Error(WORKFLOW_EDITOR_LOAD_ERROR);
    }
};

/**
 * 图片上传组件
 */
const ImageUploadComponent = {
    props: {
        uploaderHeight: {
            type: Number,
            required: true
        },
        uploderimagesrc: {
            type: String,
            default: ''
        },
        disabled: {
            type: Boolean,
            default: false
        }
    },
    template: `
        <section class="init-images">
            <div class="scroll-hide border rounded d-flex flex-wrap align-content-center justify-content-center m-2"
                 style="background-color: rgb(41, 40, 40);position: relative;"
                 :style="'height: ' + uploaderHeight + 'px'">
                <div class="m-2 text-light d-flex justify-content-center align-content-center align-items-center h-100 w-100"
                     @dragenter.prevent @dragover.prevent @dragleave.prevent @drop.prevent="handleDrop"
                     @click="triggerFileInput()"
                     :class="{ 'cursor-pointer': !disabled }"
                     ref="uploadContainer">
                    <input type="file" ref="fileInput" @change="handleChooseFile"
                           style="display: none" accept="image/*">
                    <span v-if="!PreviewimageSrc" class="text-light mx-auto text-center">
                        点击或拖拽上传图片
                    </span>
                    <div v-if="PreviewimageSrc"
                         class="position-absolute top-0 start-0 h-100 w-100 d-flex justify-content-center align-content-center">
                        <img :src="PreviewimageSrc" alt=""
                             class="m-auto h-auto mh-100 mw-100">
                    </div>
                </div>
            </div>
        </section>
    `,
    methods: {
        triggerFileInput() {
            if (this.disabled) return;
            this.$refs.fileInput.click();
        },
        handleDrop(event) {
            if (this.disabled) return;
            const file = event.dataTransfer.files[0];
            this.processFile(file);
        },
        handleChooseFile(event) {
            if (this.disabled) return;
            const file = event.target.files[0];
            this.processFile(file);
        },
        processFile(file) {
            if (!file || !file.type.startsWith('image/')) {
                emitUiNotice('请选择图片文件', 'warning');
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                const image = new Image();
                image.src = e.target.result;
                image.onload = () => {
                    // 检查尺寸限制
                    if (image.width > 3000 || image.height > 3000) {
                        emitUiNotice('图片尺寸过大！最大支持 3000x3000', 'warning');
                        return;
                    }

                    // 提取 base64 部分（去掉 data:image/xxx;base64, 前缀）
                    const base64Data = e.target.result.split(',')[1];

                    this.PreviewimageSrc = e.target.result;
                    this.$emit('update:uploderimagesrc', base64Data);
                };
            };
            reader.readAsDataURL(file);
        }
    },
    data() {
        return {
            PreviewimageSrc: null
        };
    },
    watch: {
        uploderimagesrc: {
            immediate: true,
            handler(newVal) {
                if (!newVal) {
                    this.PreviewimageSrc = null;
                } else if (!this.PreviewimageSrc) {
                    // 如果有 uploderimagesrc 但没有预览，尝试重建预览
                    this.PreviewimageSrc = `data:image/png;base64,${newVal}`;
                }
            }
        }
    }
};

/**
 * 检查图片大小
 * @param {string} base64Data - base64 编码的图片数据
 * @returns {number} 大小（字节）
 */
function getBase64Size(base64Data) {
    // base64 编码后大小约为原始大小的 4/3
    const sizeInBytes = (base64Data.length * 3) / 4;
    return sizeInBytes;
}

/**
 * 格式化文件大小
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的字符串
 */
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * 生成本地唯一 ID
 * @param {string} prefix
 * @returns {string}
 */
function generateLocalId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 深拷贝（仅用于可 JSON 序列化的数据）
 * @param {any} value
 * @returns {any}
 */
function deepCloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

/**
 * 触发全局通知事件（由 Vue 应用统一展示为自定义弹窗/Toast）
 * @param {string} message
 * @param {'success'|'info'|'warning'|'danger'} type
 */
function emitUiNotice(message, type = 'info') {
    const text = String(message || '').trim();
    if (!text) return;

    if (typeof window === 'undefined' || !window.dispatchEvent || typeof CustomEvent === 'undefined') {
        return;
    }

    window.dispatchEvent(new CustomEvent('runpod:ui-notice', {
        detail: {
            message: text,
            type
        }
    }));
}

/**
 * 获取设置初始值
 * 说明：避免 main.js 与 settings.js 出现重复默认值。
 * @returns {Object}
 */
function getInitialSettingsState() {
    if (window.Settings && typeof window.Settings.get === 'function') {
        const cfg = window.Settings.get();
        if (cfg && typeof cfg === 'object') {
            return { ...cfg };
        }
    }

    if (window.Settings && typeof window.Settings.createDefaultConfig === 'function') {
        return window.Settings.createDefaultConfig();
    }

    return {
        endpointId: '',
        apiKey: '',
        rememberApiKey: false,
        runMode: 'run',
        initialPollDelayEnabled: true,
        initialPollDelayMs: 3000,
        pollIntervalMs: 2000,

        lockParamsOnGenerate: true,
        allowConcurrent: false,
        allowQueue: false,
        maxConcurrent: 1,
        maxQueue: 5
    };
}

/**
 * 是否包含中日韩字符（用于把查询路由到中文词库）
 * @param {string} text
 * @returns {boolean}
 */
function isCjkText(text) {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(text || ''));
}

/**
 * PromptTextareaComponent
 * - Tag autocomplete for danbooru tags (positive & negative prompt)
 * - Special: token starts with '@' => artist-only search (danbooru category=1)
 * - 中文关键词（如“白发”）会自动查中文→英文词表
 */
const PromptTextareaComponent = {
    props: {
        modelValue: {
            type: String,
            default: ''
        },
        rows: {
            type: Number,
            default: 3
        },
        placeholder: {
            type: String,
            default: ''
        },
        disabled: {
            type: Boolean,
            default: false
        },
        fieldName: {
            type: String,
            default: ''
        },
        insertOptions: {
            type: Object,
            default: () => ({
                keepUnderscore: true,
                escapeParentheses: true,
                keepAtPrefix: false
            })
        }
    },
    emits: ['update:modelValue'],
    computed: {
        tagStats() {
            const value = String(this.modelValue || '');
            const tokens = value
                .split(/[,\n]/)
                .map(t => t.trim())
                .filter(Boolean);
            return { count: tokens.length, chars: value.length };
        }
    },
    template: `
        <div class="position-relative">
            <textarea
                ref="ta"
                class="form-control bg-dark text-light border-secondary"
                :rows="rows"
                :placeholder="placeholder"
                :disabled="disabled"
                :data-prompt-field="fieldName"
                :value="modelValue"
                @input="onInput"
                @keydown="onKeydown"
                @focus="onFocus"
                @blur="onBlur"
                @compositionstart="onCompositionStart"
                @compositionend="onCompositionEnd"
            ></textarea>

            <div v-if="tagStats.count > 0" class="rp-ac-hint mt-1">{{ tagStats.count }} 个标签 · {{ tagStats.chars }} 字符</div>

            <div v-if="menuOpen" class="rp-ac-menu position-absolute start-0 top-100 mt-1 w-100" ref="menuPanel">
                <div v-if="menuLoading" class="px-3 py-2 rp-ac-hint">{{ menuZhMode ? '加载中文词库中...' : '加载词库中...' }}</div>
                <div v-else-if="menuError" class="px-3 py-2 text-danger small">{{ menuError }}</div>
                <div v-else-if="menuItems.length === 0" class="px-3 py-2 rp-ac-hint">{{ menuZhMode ? '中文词库无匹配，可改用英文关键词' : '无匹配' }}</div>
                <button
                    v-for="(item, idx) in menuItems"
                    :key="item.tag"
                    :data-ac-idx="idx"
                    type="button"
                    class="list-group-item list-group-item-action rp-ac-item d-flex justify-content-between align-items-center"
                    :class="{ active: idx === activeIndex }"
                    @mousedown.prevent="onItemMouseDown(idx)"
                >
                    <span class="d-flex flex-column min-w-0">
                        <span class="d-flex align-items-center gap-2 min-w-0">
                            <span class="rp-ac-tag text-truncate">
                                <span v-for="(seg, si) in tagSegments(item.tag)" :key="'t' + si" :class="{ 'rp-ac-hl': seg.hl }">{{ seg.text }}</span>
                            </span>
                            <span v-if="item.catLabel" class="badge rp-ac-cat" :class="getCatClass(item.category)">{{ item.catLabel }}</span>
                            <span v-if="item.duplicate" class="badge rp-ac-cat rp-ac-dup">已添加</span>
                        </span>
                        <span v-if="item.zh" class="rp-ac-zh text-truncate">
                            <span v-for="(seg, si) in zhSegments(item.zh)" :key="'z' + si" :class="{ 'rp-ac-hl': seg.hl }">{{ seg.text }}</span>
                        </span>
                    </span>
                    <span class="text-muted small ms-2 flex-shrink-0">{{ formatCount(item.count) }}</span>
                </button>
            </div>
        </div>
    `,
    data() {
        return {
            isComposing: false,
            menuOpen: false,
            menuLoading: false,
            menuError: '',
            menuItems: [],
            activeIndex: 0,
            lastToken: null,
            menuToken: null,
            searchSeq: 0,
            menuZhMode: false,
            existingTagKeys: []
        };
    },
    methods: {
        formatCount(count) {
            const n = Number(count);
            if (!Number.isFinite(n)) return '';
            try {
                return n.toLocaleString();
            } catch (e) {
                return String(n);
            }
        },

        getCatLabel(cat) {
            if (cat === 1) return '画师';
            if (cat === 4) return '角色';
            if (cat === 3) return '作品';
            if (cat === 5) return 'Meta';
            if (cat === 0) return '';
            return '';
        },

        formatDisplayTag(tag) {
            const s = String(tag || '');
            const opts = this.insertOptions || {};
            if (opts.keepUnderscore === false) {
                return s.replace(/_/g, ' ');
            }
            return s;
        },

        getCatClass(cat) {
            if (cat === 1) return 'rp-cat-artist';
            if (cat === 3) return 'rp-cat-series';
            if (cat === 4) return 'rp-cat-character';
            if (cat === 5) return 'rp-cat-meta';
            return 'rp-cat-general';
        },

        // 当前输入 token 的关键词（中文模式直接整串匹配）
        currentQueryWords(forZh) {
            const token = this.lastToken || {};
            const raw = String(token.query || '').replace(/^@/, '').trim().toLowerCase();
            if (!raw) return [];
            if (forZh) return [raw];
            return raw.replace(/_/g, ' ').split(/\s+/).filter(Boolean);
        },

        // 把命中的片段包上高亮标记
        highlightSegments(text, words) {
            const str = String(text || '');
            if (!str) return [];
            if (!words || words.length === 0) return [{ text: str, hl: false }];

            const lower = str.toLowerCase();
            const marks = new Array(str.length).fill(false);
            for (let w = 0; w < words.length; w++) {
                const word = words[w];
                if (!word) continue;
                let from = 0;
                while (from <= lower.length - word.length) {
                    const at = lower.indexOf(word, from);
                    if (at === -1) break;
                    for (let i = at; i < at + word.length; i++) marks[i] = true;
                    from = at + word.length;
                }
            }

            const out = [];
            for (let i = 0; i < str.length; i++) {
                const hl = marks[i];
                const last = out[out.length - 1];
                if (last && last.hl === hl) last.text += str[i];
                else out.push({ text: str[i], hl });
            }
            return out;
        },

        tagSegments(tag) {
            return this.highlightSegments(this.formatDisplayTag(tag), this.currentQueryWords(false));
        },

        zhSegments(zh) {
            return this.highlightSegments(zh, this.currentQueryWords(true));
        },

        // 标签名规范化，用于重复检测（去 @、转义、权重、下划线）
        normalizeTagKey(text) {
            return String(text || '')
                .trim()
                .replace(/^@/, '')
                .replace(/\\/g, '')
                .replace(/^\(+|\)+$/g, '')
                .replace(/:\s*[\d.]+$/, '')
                .toLowerCase()
                .replace(/\s+/g, '_');
        },

        collectTagKeys(value) {
            const keys = String(value || '')
                .split(/[,\n]/)
                .map(t => this.normalizeTagKey(t))
                .filter(Boolean);
            return keys;
        },

        isDuplicateTag(tag) {
            const key = this.normalizeTagKey(tag);
            if (!key) return false;
            return Array.isArray(this.existingTagKeys) && this.existingTagKeys.indexOf(key) !== -1;
        },

        findToken(value, cursorPos) {
            const v = String(value || '');
            const pos = typeof cursorPos === 'number' ? cursorPos : v.length;

            const isDelimiterAt = (idx) => {
                const ch = v[idx];
                return ch === ',' || ch === '\n';
            };

            let start = 0;
            for (let i = pos - 1; i >= 0; i--) {
                if (isDelimiterAt(i)) {
                    start = i + 1;
                    break;
                }
            }

            let end = v.length;
            for (let i = pos; i < v.length; i++) {
                if (isDelimiterAt(i)) {
                    end = i;
                    break;
                }
            }

            const raw = v.slice(start, end);
            const lead = (raw.match(/^\s*/) || [''])[0];
            const core = raw.trim();

            let artistOnly = false;
            let query = core;
            if (query.startsWith('@')) {
                artistOnly = true;
                query = query.slice(1).trim();
            }

            return { start, end, raw, lead, core, query, artistOnly };
        },

        closeMenu() {
            this.menuOpen = false;
            this.menuLoading = false;
            this.menuError = '';
            this.menuItems = [];
            this.activeIndex = 0;
            this.menuZhMode = false;
            this.menuToken = null;
        },

        scrollActiveItemIntoView() {
            if (!this.menuOpen) return;
            if (!Array.isArray(this.menuItems) || this.menuItems.length === 0) return;

            this.$nextTick(() => {
                const panel = this.$refs.menuPanel;
                if (!panel || !panel.querySelector) return;

                const item = panel.querySelector(`[data-ac-idx="${this.activeIndex}"]`);
                if (!item || !item.scrollIntoView) return;

                item.scrollIntoView({ block: 'nearest' });
            });
        },

        async updateMenu() {
            if (this.isComposing) return;
            const el = this.$refs.ta;
            if (!el) return;

            const value = el.value || '';
            const pos = typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
            const token = this.findToken(value, pos);
            this.lastToken = token;

            const rawQuery = token.query || '';
            const isZhQuery = isCjkText(rawQuery);
            const q = rawQuery.toLowerCase();
            // 中文 1 个字即可联想；画师 @ 前缀允许 1 个字母（@ 单独输入列热门画师）；普通标签仍需 2 字符
            const minLen = isZhQuery ? 1 : (token.artistOnly ? 0 : 2);
            if (q.length < minLen) {
                this.closeMenu();
                return;
            }

            const seq = ++this.searchSeq;
            this.menuOpen = true;
            this.menuLoading = true;
            this.menuError = '';
            this.menuZhMode = isZhQuery;

            try {
                if (!window.TagIndex || !window.TagIndex.ensureLoaded) {
                    throw new Error('TagIndex 未加载');
                }
                if (isZhQuery) {
                    await window.TagIndex.ensureZhLoaded();
                } else {
                    await window.TagIndex.ensureLoaded();
                }
                if (seq !== this.searchSeq) return;

                const results = isZhQuery
                    ? window.TagIndex.searchZh(rawQuery, { limit: 20, artistOnly: token.artistOnly })
                    : window.TagIndex.search(q, { limit: 20, artistOnly: token.artistOnly });
                this.existingTagKeys = this.collectTagKeys(value);
                // 记录生成当前菜单的 token 快照，选中时用于判定候选是否过期
                this.menuToken = token;
                this.menuItems = (results || []).map(r => ({
                    tag: r.tag,
                    category: r.category,
                    catLabel: this.getCatLabel(r.category),
                    count: r.count,
                    zh: isZhQuery ? (r.zh || '') : window.TagIndex.getZh(r.tag),
                    duplicate: this.isDuplicateTag(r.tag)
                }));
                this.activeIndex = 0;
                this.menuLoading = false;
                this.scrollActiveItemIntoView();
            } catch (e) {
                if (seq !== this.searchSeq) return;
                this.menuLoading = false;
                this.menuError = (e && e.message) ? e.message : String(e);
            }
        },

        // 当前 token 是否仍对应生成菜单时的那个 token（避免用旧候选覆盖别的词）
        isSelectionTokenUsable(token, snapshot, item) {
            if (!token || !snapshot) return false;
            if (token.core !== snapshot.core) return false;
            if (!!token.artistOnly !== !!snapshot.artistOnly) return false;
            // 画师/普通互斥：候选分类必须与当前 token 的 @ 语义一致
            const itemIsArtist = Number(item && item.category) === 1;
            return itemIsArtist === !!token.artistOnly;
        },

        applySelection(item) {
            if (!item || !item.tag) return;

            const el = this.$refs.ta;
            if (!el) return;
            const value = el.value || '';

            // 不信任缓存的 lastToken：按当前值 + 当前选区重新解析 token
            const pos = typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
            const token = this.findToken(value, pos);

            // 输入/光标已改变导致候选过期时：不改文本，直接关菜单
            if (!this.isSelectionTokenUsable(token, this.menuToken, item)) {
                this.closeMenu();
                return;
            }

            const opts = this.insertOptions || {};
            const shouldKeepAt = !!opts.keepAtPrefix && !!token.artistOnly;
            const atPrefix = shouldKeepAt ? '@' : '';
            let tagText = String(item.tag);
            if (opts.keepUnderscore === false) {
                tagText = tagText.replace(/_/g, ' ');
            }
            if (opts.escapeParentheses) {
                tagText = tagText.replace(/\(/g, '\\(').replace(/\)/g, '\\)');
            }

            let replacement = `${token.lead || ''}${atPrefix}${tagText}`;

            // token 解析会把 CRLF 行尾的 \r 归入 token，这里退回以免插入时删掉 CR
            let tokenEnd = token.end;
            if (tokenEnd > token.start && value[tokenEnd - 1] === '\r' && value[tokenEnd] === '\n') {
                tokenEnd -= 1;
            }

            // 在末尾选择时自动补 ", " 方便继续输入
            const after = value.slice(tokenEnd);
            if (!after) {
                const trimmed = (value.slice(0, token.start) + replacement).trimEnd();
                if (trimmed && !trimmed.endsWith(',') && !trimmed.endsWith('\n')) {
                    replacement += ', ';
                }
            } else if (/^\r?\n/.test(after)) {
                // token 在行末（后面紧跟换行）：只补逗号，不加空格，保留原换行与后续行
                const prefix = (value.slice(0, token.start) + replacement).trimEnd();
                if (prefix && !prefix.endsWith(',')) {
                    replacement += ',';
                }
            }

            this.replaceRange(el, token.start, tokenEnd, replacement);
            this.closeMenu();
        },

        // 用 insertText 写入，保留浏览器原生撤销栈（Ctrl+Z 可回退联想插入）
        replaceRange(el, start, end, text) {
            let inserted = false;
            try {
                el.focus();
                el.setSelectionRange(start, end);
                inserted = document.execCommand('insertText', false, text);
            } catch (e) {
                inserted = false;
            }

            if (!inserted) {
                const current = el.value || '';
                el.value = current.slice(0, start) + text + current.slice(end);
                try {
                    el.setSelectionRange(start + text.length, start + text.length);
                } catch (e) {
                    // ignore
                }
            }

            this.$emit('update:modelValue', el.value || '');
        },

        onItemMouseDown(idx) {
            const item = this.menuItems[idx];
            this.applySelection(item);
            this.$nextTick(() => {
                const el = this.$refs.ta;
                if (el && el.focus) el.focus();
            });
        },

        onInput(e) {
            const v = e && e.target ? e.target.value : '';
            this.$emit('update:modelValue', v);
            this.updateMenu();
        },

        onFocus() {
            // 懒加载 + 初始化一次搜索
            this.updateMenu();
        },

        onBlur() {
            // 延迟关闭，给鼠标点击选择留时间（mousedown 先于 blur）
            setTimeout(() => {
                this.closeMenu();
            }, 120);
        },

        onCompositionStart() {
            this.isComposing = true;
        },

        onCompositionEnd() {
            this.isComposing = false;
            this.updateMenu();
        },

        onKeydown(e) {
            if (!e) return;
            if (this.isComposing) return;
            if (!this.menuOpen) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (this.menuItems.length === 0) return;
                this.activeIndex = (this.activeIndex + 1) % this.menuItems.length;
                this.scrollActiveItemIntoView();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this.menuItems.length === 0) return;
                this.activeIndex = (this.activeIndex - 1 + this.menuItems.length) % this.menuItems.length;
                this.scrollActiveItemIntoView();
            } else if (e.key === 'PageDown') {
                e.preventDefault();
                if (this.menuItems.length === 0) return;
                this.activeIndex = Math.min(this.menuItems.length - 1, this.activeIndex + 5);
                this.scrollActiveItemIntoView();
            } else if (e.key === 'PageUp') {
                e.preventDefault();
                if (this.menuItems.length === 0) return;
                this.activeIndex = Math.max(0, this.activeIndex - 5);
                this.scrollActiveItemIntoView();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.closeMenu();
            } else if (e.key === 'Tab') {
                if (this.menuItems.length === 0) return;
                e.preventDefault();
                const item = this.menuItems[this.activeIndex];
                this.applySelection(item);
            }
        }
    }
};

const app = Vue.createApp({
    data() {
        const initialSettings = getInitialSettingsState();

        return {
            // ========== 配置状态 ==========
            isConfigValid: false,
            connectionStatus: '未配置',

            // ========== 模板相关 ==========
            selectedTemplateId: '',
            builtinTemplates: [],
            userTemplates: [],
            selectedTemplate: null,

            // ========== 前台视图 / 统一库 ==========
            mainView: 'generate', // 'generate' | 'library'
            visibleBuiltinTemplates: [],
            catalogStatus: 'idle', // 'idle' | 'loading' | 'ready' | 'offline' | 'error'
            catalogVersion: 0,
            catalogItems: [],
            catalogError: '',
            catalogEtag: '',
            catalogSavedAt: null,
            catalogAliasMap: {},
            catalogDetails: {},
            previewBroken: {},
            libraryKind: 'template', // 'template' | 'preset' | 'snippet'
            librarySource: 'shared', // 'shared' | 'local'
            librarySearch: '',
            libraryCategory: '',
            libraryLoading: false,
            libraryDetailLoadingId: '',
            templateDetailLoadingId: '',
            mobileResultsOpen: false,
            showQuickPromptPanel: true,
            quickPromptSearch: '',
            quickPromptTab: 'presets', // 'presets' | 'snippets'
            promptUndo: null,
            lastPromptField: '',
            renameState: {
                show: false,
                id: '',
                kind: '',
                value: ''
            },

            // ========== Workflow 相关 ==========
            workflowJson: '',
            workflowError: '',
            workflowObj: null,
            showPreview: false,
            isWorkflowCollapsed: true,
            cursorPosition: 0,
            workflowView: 'graph',
            workflowEditorMeta: WorkflowEditor.normalizeEditor({}),
            selectedWorkflowNodeId: '',
            isWorkflowEditorDirty: false,
            loraDrafts: [],
            pendingExposeInput: null,
            exposeForm: {
                id: '',
                label: '',
                control: 'text',
                min: '',
                max: '',
                step: ''
            },

            // ========== 占位符相关 ==========
            placeholders: [],
            placeholderValues: {},
            placeholderErrors: [],
            selectedSizePreset: '',
            seedRandomEachRun: false,

            // 参数面板：各模块展开/收起状态
            paramSectionsOpen: {
                size: true,
                prompt: true,
                sampling: true,
                inputImage: true,
                other: true
            },

            // ========== 提示词预设 ==========
            showPromptPresets: false,
            promptPresetTab: 'blocks', // 'blocks' | 'snippets'
            promptPresetMessage: '',
            promptPresetMessageType: '', // 'success' | 'danger' | 'warning' | ''
            promptPresetSearch: '',
            newPromptBlockName: '',
            promptBlockPresets: [],
            appliedBlockPresetId: '',
            newPromptSnippetName: '',
            newPromptSnippetText: '',
            promptSnippetPresets: [],

            // ========== 提示词输入体验 ==========
            showPromptInputOptions: false,

            // ========== 提示词参考站点 ==========
            // 面板里的链接完全由这个数组驱动：加一条 = 多一个链接
            // badge 用作分组标注（画师/标签/作品…），icon 用 bootstrap-icons 名
            showPromptRefs: false,
            promptRefSites: [
                {
                    name: 'Animadex',
                    url: 'https://animadex.net/',
                    desc: '画师 / 作品索引，查画风与代表作',
                    badge: '画师',
                    icon: 'bi-person-badge'
                },
                {
                    name: 'Danbooru Wiki',
                    url: 'https://danbooru.donmai.us/wiki_pages',
                    desc: '标签释义、别名与相关标签',
                    badge: '标签',
                    icon: 'bi-book'
                }
            ],
            promptInsertOptions: {
                keepUnderscore: true,
                escapeParentheses: true,
                keepAtPrefix: false
            },

            // ========== 输入图片 ==========
            inputImages: [],
            inputImageData: '',
            inputImageSizeWarning: '',

            // ========== 生成调度（并发/排队） ==========
            // activeJobs: [{ taskId, historyId, runMode, cancelRequested, jobId, pollOnly? }]
            activeJobs: [],
            // jobQueue:  [{ taskId, historyId, runMode, cancelRequested, jobId, payload, pollOnly? }]
            jobQueue: [],
            errorMessage: '',

            // ========== 结果 ==========
            resultsTab: 'history', // 'history' | 'gallery'
            requestHistory: [],
            selectedHistoryId: '',
            selectedHistoryImageIndex: 0,
            selectedGalleryIndex: 0,
            historyListDesktopMaxHeight: 0,

            // ========== 收藏 ==========
            favorites: [],
            // 收藏图片缓存（用于在请求记录被裁剪后仍可展示收藏）
            // { [imageId]: { id, filename, type, data, imageUrl, createdAt } }
            favoriteImageCache: {},
            showFavoritesPanel: false,
            selectedFavoriteIndex: 0,

            // ========== 设置相关 ==========
            showSettings: false,
            showApiKey: false,
            // 当前已生效的设置（点击“保存设置”后更新）
            settings: { ...initialSettings },
            settingsForm: { ...initialSettings },
            testingConnection: false,
            connectionTestResult: null,

            // ========== 模板保存 ==========
            showSaveTemplate: false,
            newTemplateName: '',
            newTemplateDescription: '',

            // ========== 模板导入 ==========
            showImportTemplate: false,
            importTemplateJson: '',
            importError: '',
            importTemplateFileName: '',

            // ========== 图片预览 ==========
            showImageModal: false,
            previewMode: 'history', // 'history' | 'gallery' | 'favorites'
            previewHistoryId: '',
            previewIndex: 0,
            previewTransitionName: 'rp-slide-next',
            showPreviewParams: false,
            previewDragX: 0,
            previewIsDragging: false,
            previewIsSwiping: false,
            previewTouchStartX: 0,
            previewTouchStartY: 0,

            // ========== 自定义通知/确认弹窗 ==========
            uiToast: {
                show: false,
                message: '',
                type: 'info'
            },
            uiDialog: {
                show: false,
                title: '提示',
                message: '',
                type: 'info',
                showCancel: false,
                confirmText: '确定',
                cancelText: '取消'
            }
        };
    },

    computed: {
        isConfigured() {
            return this.isConfigValid;
        },

        canGenerate() {
            if (this.templateDetailLoadingId) return false;
            if (!this.isConfigured) return false;
            if (!this.workflowJson.trim()) return false;
            if (this.workflowError) return false;
            if (this.placeholderErrors.length > 0) return false;
            if (this.workflowEditorErrors.length > 0) return false;
            return true;
        },

        // ========== 并发 / 排队 ==========
        activeJobCount() {
            return Array.isArray(this.activeJobs) ? this.activeJobs.length : 0;
        },

        queuedJobCount() {
            return Array.isArray(this.jobQueue) ? this.jobQueue.length : 0;
        },

        effectiveGenerationSettings() {
            return this.getEffectiveGenerationSettings();
        },

        isParamsLocked() {
            // 统一库模板详情加载中：禁止提交/改参数，避免用旧 workflow 提交
            if (this.templateDetailLoadingId) return true;
            const s = this.effectiveGenerationSettings;
            if (!s.lockParamsOnGenerate) return false;
            return this.activeJobCount > 0;
        },

        canAcceptNewJob() {
            const s = this.effectiveGenerationSettings;
            const active = this.activeJobCount;
            const queued = this.queuedJobCount;
            if (active < s.maxConcurrent) return true;
            if (s.allowQueue && queued < s.maxQueue) return true;
            return false;
        },

        canCancelSelected() {
            const rec = this.selectedHistoryRecord;
            if (!rec || !rec.id) return false;
            return (this.activeJobs || []).some(j => j && j.historyId === rec.id)
                || (this.jobQueue || []).some(j => j && j.historyId === rec.id);
        },

        canCancelAll() {
            return this.activeJobCount > 0 || this.queuedJobCount > 0;
        },

        canSaveTemplate() {
            return this.workflowJson.trim() && !this.workflowError;
        },

        canUpdateTemplate() {
            return this.selectedTemplate && !TemplateManager.isReadonly(this.selectedTemplate) && this.canSaveTemplate;
        },

        canDeleteTemplate() {
            return this.selectedTemplate && !TemplateManager.isReadonly(this.selectedTemplate);
        },

        // ========== 统一库 / 本地资源 ==========
        isCatalogOnline() {
            return this.catalogStatus === 'ready';
        },

        catalogCacheAgeLabel() {
            return CatalogClient.formatCacheAge(this.catalogSavedAt);
        },

        catalogSourceLabel() {
            if (this.catalogStatus === 'offline') {
                return `离线数据 · 最后同步 ${this.catalogCacheAgeLabel}`;
            }
            if (this.catalogStatus === 'loading') return '同步中...';
            if (this.catalogStatus === 'error') return '统一库暂不可用';
            return `统一库 v${this.catalogVersion || 0}`;
        },

        catalogTemplateItems() {
            return (this.catalogItems || []).filter(item => item && item.kind === 'template');
        },

        libraryLocalItems() {
            const kind = this.libraryKind;
            if (kind === 'template') {
                return (this.userTemplates || []).map(t => ({
                    id: t.id,
                    kind: 'template',
                    name: t.name,
                    description: t.description || '',
                    category: '',
                    source: CatalogClient.sourceOf(t),
                    isBuiltin: !!t.isBuiltin,
                    sourceId: t.sourceId || '',
                    sourceRevision: Number.isFinite(Number(t.sourceRevision)) ? Number(t.sourceRevision) : null,
                    preview: CatalogClient.normalizePreview(t.preview),
                    updatedAt: t.updatedAt || t.createdAt || null
                }));
            }
            if (kind === 'preset') {
                return (this.promptBlockPresets || []).map(p => ({
                    id: p.id,
                    kind: 'preset',
                    name: p.name,
                    description: [p.prompt ? `正: ${p.prompt}` : '', p.negative_prompt ? `负: ${p.negative_prompt}` : ''].filter(Boolean).join(' · '),
                    category: '',
                    source: CatalogClient.sourceOf(p),
                    sourceId: p.sourceId || '',
                    sourceRevision: Number.isFinite(Number(p.sourceRevision)) ? Number(p.sourceRevision) : null,
                    preview: CatalogClient.normalizePreview(p.preview),
                    updatedAt: p.updatedAt || p.createdAt || null
                }));
            }
            return (this.promptSnippetPresets || []).map(s => ({
                id: s.id,
                kind: 'snippet',
                name: s.name,
                description: s.text || '',
                category: '',
                source: CatalogClient.sourceOf(s),
                sourceId: s.sourceId || '',
                sourceRevision: Number.isFinite(Number(s.sourceRevision)) ? Number(s.sourceRevision) : null,
                preview: CatalogClient.normalizePreview(s.preview),
                target: s.target === 'negative' ? 'negative' : 'positive',
                updatedAt: s.updatedAt || s.createdAt || null
            }));
        },

        libraryItems() {
            const sourceItems = this.librarySource === 'shared'
                ? (this.catalogItems || [])
                : this.libraryLocalItems;
            const q = String(this.librarySearch || '').trim().toLowerCase();
            const category = String(this.libraryCategory || '').trim();
            return sourceItems.filter(item => {
                if (!item || item.kind !== this.libraryKind) return false;
                if (category && String(item.category || '') !== category) return false;
                if (!q) return true;
                const haystack = [item.name, item.description, item.category].map(v => String(v || '').toLowerCase()).join('\n');
                return haystack.includes(q);
            });
        },

        libraryCategories() {
            const sourceItems = this.librarySource === 'shared' ? (this.catalogItems || []) : this.libraryLocalItems;
            const values = new Set();
            sourceItems.forEach(item => {
                if (!item || item.kind !== this.libraryKind) return;
                const c = String(item.category || '').trim();
                if (c) values.add(c);
            });
            return Array.from(values).sort((a, b) => a.localeCompare(b, 'zh-CN'));
        },

        libraryKindLabel() {
            if (this.libraryKind === 'template') return '工作流模板';
            if (this.libraryKind === 'preset') return '提示词预设';
            return '片段';
        },

        libraryUseLabel() {
            if (this.libraryKind === 'template') return '使用模板';
            if (this.libraryKind === 'preset') return '替换提示词';
            return '插入片段';
        },

        quickPromptPresets() {
            const q = String(this.quickPromptSearch || '').trim().toLowerCase();
            const list = Array.isArray(this.promptBlockPresets) ? this.promptBlockPresets : [];
            if (!q) return list;
            return list.filter(p => p && (String(p.name || '').toLowerCase().includes(q)
                || String(p.prompt || '').toLowerCase().includes(q)
                || String(p.negative_prompt || '').toLowerCase().includes(q)));
        },

        quickPromptSnippets() {
            const q = String(this.quickPromptSearch || '').trim().toLowerCase();
            const list = Array.isArray(this.promptSnippetPresets) ? this.promptSnippetPresets : [];
            if (!q) return list;
            return list.filter(s => s && (String(s.name || '').toLowerCase().includes(q)
                || String(s.text || '').toLowerCase().includes(q)));
        },

        canTestConnection() {
            return this.settingsForm.endpointId && this.settingsForm.apiKey;
        },

        runModeLabel() {
            return (this.settings && this.settings.runMode) === 'run' ? '异步' : '同步';
        },

        connectionStatusClass() {
            if (!this.isConfigured) return 'bg-secondary';
            return 'bg-success';
        },

        promptPresetMessageClass() {
            const t = this.promptPresetMessageType;
            if (t === 'success') return 'alert-success';
            if (t === 'danger') return 'alert-danger';
            if (t === 'warning') return 'alert-warning';
            return 'alert-secondary';
        },

        promptPresetMessageIcon() {
            const t = this.promptPresetMessageType;
            if (t === 'success') return 'bi-check-circle';
            if (t === 'danger') return 'bi-exclamation-circle';
            if (t === 'warning') return 'bi-exclamation-triangle';
            return 'bi-info-circle';
        },

        filteredPromptBlockPresets() {
            const q = String(this.promptPresetSearch || '').trim().toLowerCase();
            const list = Array.isArray(this.promptBlockPresets) ? this.promptBlockPresets : [];
            if (!q) return list;
            return list.filter(p => {
                if (!p) return false;
                const name = String(p.name || '').toLowerCase();
                const pos = String(p.prompt || '').toLowerCase();
                const neg = String(p.negative_prompt || '').toLowerCase();
                return name.includes(q) || pos.includes(q) || neg.includes(q);
            });
        },

        filteredPromptSnippetPresets() {
            const q = String(this.promptPresetSearch || '').trim().toLowerCase();
            const list = Array.isArray(this.promptSnippetPresets) ? this.promptSnippetPresets : [];
            if (!q) return list;
            return list.filter(s => {
                if (!s) return false;
                const name = String(s.name || '').toLowerCase();
                const text = String(s.text || '').toLowerCase();
                return name.includes(q) || text.includes(q);
            });
        },

        // ========== 结果视图 ==========
        hasResultsSection() {
            return this.requestHistory.length > 0;
        },

        selectedHistoryRecord() {
            if (this.requestHistory.length === 0) return null;
            const found = this.requestHistory.find(r => r.id === this.selectedHistoryId);
            return found || this.requestHistory[0];
        },

        historyListDesktopStyle() {
            const h = Number(this.historyListDesktopMaxHeight || 0);
            if (!Number.isFinite(h) || h <= 0) {
                return {};
            }
            return {
                maxHeight: `${Math.max(120, Math.floor(h))}px`
            };
        },

        selectedHistoryParamsForJson() {
            const record = this.selectedHistoryRecord;
            const values = record && record.placeholderValues ? record.placeholderValues : null;
            if (!values || typeof values !== 'object') return {};

            // 避免与上方 Prompt / Negative Prompt 重复
            const out = { ...values };
            delete out.prompt;
            delete out.negative_prompt;
            return out;
        },

        selectedHistoryImages() {
            const record = this.selectedHistoryRecord;
            return record && Array.isArray(record.images) ? record.images : [];
        },

        selectedHistoryImage() {
            const images = this.selectedHistoryImages;
            if (images.length === 0) return null;
            const idx = Math.max(0, Math.min(this.selectedHistoryImageIndex, images.length - 1));
            return images[idx];
        },

        galleryImages() {
            const images = [];
            this.requestHistory.forEach(record => {
                (record.images || []).forEach((img, indexInRequest) => {
                    images.push({
                        ...img,
                        requestId: record.id,
                        requestJobId: record.jobId || '',
                        requestCreatedAt: record.createdAt,
                        requestTemplateId: record.templateId || '',
                        requestTemplateName: record.templateName || '',
                        indexInRequest
                    });
                });
            });
            return images;
        },

        favoriteImages() {
            const favs = Array.isArray(this.favorites) ? this.favorites : [];
            if (favs.length === 0) return [];

            const fromHistory = new Map();
            this.requestHistory.forEach(r => {
                (r.images || []).forEach(img => {
                    if (img && img.id) fromHistory.set(img.id, img);
                });
            });

            const cache = this.favoriteImageCache || {};
            const items = [];

            favs.forEach(f => {
                if (!f || !f.id) return;
                const img = fromHistory.get(f.id) || cache[f.id];
                if (!img) return;
                items.push({
                    ...img,
                    favoriteAddedAt: f.addedAt || null,
                    favoriteRequestId: f.requestId || '',
                    favoriteRequestTemplateName: f.requestTemplateName || '',
                    favoritePlaceholderValues: f.placeholderValues || null
                });
            });

            items.sort((a, b) => (b.favoriteAddedAt || 0) - (a.favoriteAddedAt || 0));
            return items;
        },

        favoriteCount() {
            return Array.isArray(this.favorites) ? this.favorites.length : 0;
        },

        selectedGalleryImage() {
            const images = this.galleryImages;
            if (images.length === 0) return null;
            const idx = Math.max(0, Math.min(this.selectedGalleryIndex, images.length - 1));
            return images[idx];
        },

        detailRecord() {
            if (this.resultsTab === 'gallery') {
                const img = this.selectedGalleryImage;
                if (!img) return null;
                return this.requestHistory.find(r => r.id === img.requestId) || null;
            }
            return this.selectedHistoryRecord;
        },

        detailImage() {
            return this.resultsTab === 'gallery' ? this.selectedGalleryImage : this.selectedHistoryImage;
        },

        // ========== 图片预览 ==========
        previewImages() {
            if (this.previewMode === 'favorites') {
                return this.favoriteImages;
            }
            if (this.previewMode === 'gallery') {
                return this.galleryImages;
            }

            const historyId = this.previewHistoryId || (this.selectedHistoryRecord ? this.selectedHistoryRecord.id : '');
            const record = this.requestHistory.find(r => r.id === historyId);
            return record && Array.isArray(record.images) ? record.images : [];
        },

        previewImage() {
            const images = this.previewImages;
            if (images.length === 0) return null;
            const idx = Math.max(0, Math.min(this.previewIndex, images.length - 1));
            return images[idx];
        },

        previewParamValues() {
            const img = this.previewImage;
            if (!img) return null;

            const normalize = (values) => {
                if (!values || typeof values !== 'object') return null;
                return Object.keys(values).length > 0 ? values : null;
            };

            if (this.previewMode === 'favorites') {
                const fav = (this.favorites || []).find(f => f && f.id === img.id);
                const fromFav = normalize(fav && fav.placeholderValues);
                if (fromFav) return fromFav;

                // 收藏缺少参数时，尝试从历史记录补齐
                if (fav && fav.requestId) {
                    const rec = this.requestHistory.find(r => r.id === fav.requestId);
                    return normalize(rec && rec.placeholderValues);
                }

                return null;
            }

            if (this.previewMode === 'gallery') {
                const requestId = img.requestId;
                if (!requestId) return null;
                const rec = this.requestHistory.find(r => r.id === requestId);
                return normalize(rec && rec.placeholderValues);
            }

            const historyId = this.previewHistoryId || (this.selectedHistoryRecord ? this.selectedHistoryRecord.id : '');
            const rec = this.requestHistory.find(r => r.id === historyId);
            return normalize(rec && rec.placeholderValues);
        },

        previewCanPrev() {
            return this.previewImages.length > 0 && this.previewIndex > 0;
        },

        previewCanNext() {
            const images = this.previewImages;
            return images.length > 0 && this.previewIndex < images.length - 1;
        },

        previewIndicatorText() {
            const total = this.previewImages.length;
            if (!total) return '';
            const idx = Math.max(0, Math.min(this.previewIndex, total - 1));
            return `${idx + 1} / ${total}`;
        },

        previewMediaStyle() {
            const x = Number(this.previewDragX || 0);
            if (!this.previewIsDragging || !x) return {};
            return { transform: `translateX(${x}px)` };
        },

        // 占位符分组
        hasSizePlaceholders() {
            return this.placeholders.some(p => p.name === 'width' || p.name === 'height');
        },

        hasPromptPlaceholders() {
            return this.placeholders.some(p =>
                p.name === 'prompt' || p.name === 'negative_prompt'
            );
        },

        hasSamplingPlaceholders() {
            return this.placeholders.some(p =>
                ['seed', 'steps', 'cfg', 'denoise', 'sampler_name', 'scheduler', 'batch_size'].includes(p.name)
            );
        },

        hasSeedPlaceholder() {
            return this.placeholders.some(p => p.name === 'seed');
        },

        hasInputImagePlaceholder() {
            return this.placeholders.some(p => p.name === 'input_image');
        },

        promptPlaceholders() {
            return this.placeholders.filter(p =>
                p.name === 'prompt' || p.name === 'negative_prompt'
            );
        },

        samplingPlaceholders() {
            return this.placeholders.filter(p =>
                ['seed', 'steps', 'cfg', 'denoise', 'sampler_name', 'scheduler', 'batch_size'].includes(p.name)
            );
        },

        otherPlaceholders() {
            const known = ['width', 'height', 'prompt', 'negative_prompt', 'seed', 'steps', 'cfg', 'denoise', 'sampler_name', 'scheduler', 'batch_size', 'input_image'];
            return this.placeholders.filter(p => !known.includes(p.name));
        },

        sizePresets() {
            return PlaceholderEngine.getSizePresets();
        },

        placeholderChips() {
            return ['{{width}}', '{{height}}', '{{prompt}}', '{{negative_prompt}}', '{{seed}}', '{{steps}}', '{{cfg}}', '{{input_image}}'];
        },

        workflowGraph() {
            const graph = WorkflowEditor.parse(this.workflowObj);
            if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
                return createEmptyWorkflowGraph();
            }
            return {
                nodes: graph.nodes,
                edges: graph.edges,
                warnings: Array.isArray(graph.warnings) ? graph.warnings : []
            };
        },

        selectedWorkflowNode() {
            return this.workflowGraph.nodes.find(node => node.id === this.selectedWorkflowNodeId) || null;
        },

        workflowProfileValidation() {
            return WorkflowEditor.validateProfile(this.workflowObj, this.workflowEditorMeta);
        },

        canEditLoraChain() {
            return this.workflowProfileValidation.valid;
        },

        workflowEditorErrors() {
            const errors = [];
            if (this.canEditLoraChain) {
                this.loraDrafts.forEach((lora, index) => {
                    if (!String(lora && lora.name || '').trim()) {
                        errors.push(`LoRA ${index + 1} 缺少文件名`);
                    }
                    ['strengthModel', 'strengthClip'].forEach(key => {
                        const value = Number(lora && lora[key]);
                        if (!Number.isFinite(value) || value < -100 || value > 100) {
                            errors.push(`LoRA ${index + 1} 强度必须在 -100 到 100 之间`);
                        }
                    });
                });
            }
            return errors;
        },

        executionWorkflowJson() {
            return this.finalWorkflow ? JSON.stringify(this.finalWorkflow, null, 2) : '';
        },

        workflowParameterBindings() {
            return WorkflowEditor.mergeParameterBindings(this.workflowObj, this.workflowEditorMeta);
        },

        // 最终替换后的 workflow
        finalWorkflow() {
            if (!this.workflowObj) return null;
            return PlaceholderEngine.replace(
                this.workflowObj,
                this.placeholderValues,
                this.placeholders
            );
        }
    },

    created() {
        this.initParamSectionsOpenState();
        this.loadLastPlaceholderValuesDraft();
        this.loadWorkflowCollapsedState();
        this.loadSeedRandomEachRunState();
        this.loadPromptInsertOptions();
    },

    mounted() {
        // 加载设置
        const settings = Settings.get();
        this.settings = { ...settings };
        this.settingsForm = { ...settings };

        // 初始化 RunPod 客户端
        RunpodClient.setConfig({
            endpointId: settings.endpointId,
            apiKey: settings.apiKey
        });

        // 加载内置模板
        TemplateManager.setBuiltinTemplates(window.BuiltinTemplates || []);
        this.builtinTemplates = TemplateManager.builtinTemplates;
        this.visibleBuiltinTemplates = this.builtinTemplates.slice();
        this.catalogAliasMap = CatalogClient.loadAliasMap(localStorage);
        this.loadUserTemplates();

        // 恢复上次选择的模板（工作流）
        this.restoreSelectedTemplateId();

        // 更新配置状态
        this.isConfigValid = Settings.isConfigured();
        this.updateConnectionStatus();

        // 加载持久化历史
        this.loadPersistedHistory();

        // 加载提示词预设
        this.loadPromptPresets();

        // 统一库为增强能力：后台不可用时保持内置/本地工作流可生成
        this.loadCatalogIfNeeded();

        this._promptCaretHandler = (event) => {
            const el = event && event.target;
            if (!el || el.tagName !== 'TEXTAREA') return;
            this.recordPromptCaret(el);
        };
        document.addEventListener('focusin', this._promptCaretHandler);
        document.addEventListener('keyup', this._promptCaretHandler);
        document.addEventListener('mouseup', this._promptCaretHandler);
        document.addEventListener('input', this._promptCaretHandler);

        // 全局按键（图片预览）
        window.addEventListener('keydown', this.onGlobalKeydown);
        window.addEventListener('resize', this.onWindowResize);

        this._uiNoticeHandler = (event) => {
            const detail = event && event.detail ? event.detail : {};
            this.showUiToast(detail.message || '', detail.type || 'info');
        };
        window.addEventListener('runpod:ui-notice', this._uiNoticeHandler);

        // 首次渲染后同步桌面历史列表高度
        this.queueSyncHistoryListDesktopHeight();
        this.$nextTick(() => this.queueWorkflowGraphRender());

        // 空闲时预加载标签库（含中文词库），避免首次输入时等待
        this.preloadTagIndexes();
    },

    beforeUnmount() {
        window.removeEventListener('keydown', this.onGlobalKeydown);
        window.removeEventListener('resize', this.onWindowResize);
        if (this._promptCaretHandler) {
            document.removeEventListener('focusin', this._promptCaretHandler);
            document.removeEventListener('keyup', this._promptCaretHandler);
            document.removeEventListener('mouseup', this._promptCaretHandler);
            document.removeEventListener('input', this._promptCaretHandler);
            this._promptCaretHandler = null;
        }
        if (this._uiNoticeHandler) {
            window.removeEventListener('runpod:ui-notice', this._uiNoticeHandler);
            this._uiNoticeHandler = null;
        }

        if (this._historyListDesktopRaf) {
            cancelAnimationFrame(this._historyListDesktopRaf);
            this._historyListDesktopRaf = null;
        }

        if (this._persistTimer) {
            clearTimeout(this._persistTimer);
            this._persistTimer = null;
        }

        if (this._promptPresetMsgTimer) {
            clearTimeout(this._promptPresetMsgTimer);
            this._promptPresetMsgTimer = null;
        }

        if (this._lastPlaceholderPersistTimer) {
            clearTimeout(this._lastPlaceholderPersistTimer);
            this._lastPlaceholderPersistTimer = null;
        }

        if (this._uiToastTimer) {
            clearTimeout(this._uiToastTimer);
            this._uiToastTimer = null;
        }

        if (this._uiDialogResolver) {
            this._uiDialogResolver(false);
            this._uiDialogResolver = null;
        }

        if (this._workflowGraphRaf) {
            cancelAnimationFrame(this._workflowGraphRaf);
            this._workflowGraphRaf = null;
        }

        if (this._workflowCy) {
            this._workflowCy.destroy();
            this._workflowCy = null;
        }
    },

    watch: {
        selectedTemplateId(newVal, oldVal) {
            this.persistSelectedTemplateId();

            // 切换模板：先保存旧模板自己的草稿，再载入目标模板的草稿（无则默认值）
            if (newVal !== oldVal) {
                // 只保存“实际已应用”模板的草稿：未应用/挂起的 oldVal 不写，避免把当前值当成它的草稿
                if (oldVal && this.selectedTemplate && this.selectedTemplate.id === oldVal) {
                    this.persistTemplateDraftFor(oldVal, this.placeholderValues);
                }
                this._pendingTemplateDraft = this.loadTemplateDraftFor(newVal);
                this._templateSwitchKeepValues = null;
                this.selectedSizePreset = '';
                this.showPromptInputOptions = false;
            }

            this.onTemplateSelect();
        },

        promptInsertOptions: {
            deep: true,
            handler() {
                this.persistPromptInsertOptions();
            }
        },

        seedRandomEachRun(val) {
            this.persistSeedRandomEachRunState();
        },

        isWorkflowCollapsed(val) {
            this.persistWorkflowCollapsedState();
        },

        selectedSizePreset() {
            this.applySizePreset();
        },

        workflowJson(val) {
            this.parseWorkflow();
        },

        mainView(val) {
            if (val === 'library') {
                this.loadCatalogIfNeeded();
            }
        },

        workflowView(val) {
            if (val === 'graph') {
                this.queueWorkflowGraphRender();
            }
        },

        inputImages: {
            deep: true,
            handler(images) {
                images.forEach(img => {
                    if (img.image) {
                        const size = getBase64Size(img.image);
                        if (size > 9 * 1024 * 1024) { // 9MB 警告
                            img.sizeWarning = `图片较大 (${formatFileSize(size)})，可能导致请求超过 10MB 限制`;
                        } else {
                            img.sizeWarning = '';
                        }
                    } else {
                        img.sizeWarning = '';
                    }
                });
            }
        },

        // 监听占位符值变化，验证
        placeholderValues: {
            deep: true,
            handler() {
                // 提示词被改动时，清除"已应用"预设高亮（内容仍匹配则保留）
                if (this.appliedBlockPresetId) {
                    const preset = (this.promptBlockPresets || []).find(p => p && p.id === this.appliedBlockPresetId);
                    const stillMatches = preset
                        && String(this.placeholderValues.prompt || '') === String(preset.prompt || '')
                        && String(this.placeholderValues.negative_prompt || '') === String(preset.negative_prompt || '');
                    if (!stillMatches) {
                        this.appliedBlockPresetId = '';
                    }
                }
                this.validatePlaceholders();
                this.queuePersistLastPlaceholderValues();
            }
        },

        // 监听输入图片大小
        inputImageData(val) {
            if (val) {
                const size = getBase64Size(val);
                if (size > 9 * 1024 * 1024) { // 9MB 警告
                    this.inputImageSizeWarning = `图片较大 (${formatFileSize(size)})，可能导致请求超过 10MB 限制`;
                } else {
                    this.inputImageSizeWarning = '';
                }
            } else {
                this.inputImageSizeWarning = '';
            }
        },

        // 设置表单：基础逻辑约束
        'settingsForm.allowQueue'(val) {
            // 允许排队时，锁参数必定关闭（否则无法继续改参数做下一次排队）
            if (val) {
                this.settingsForm.lockParamsOnGenerate = false;
            }
        },

        'settingsForm.allowConcurrent'(val) {
            if (!val) {
                this.settingsForm.maxConcurrent = 1;
            }
        },

        resultsTab() {
            this.queueSyncHistoryListDesktopHeight();
        },

        selectedHistoryId() {
            this.queueSyncHistoryListDesktopHeight();
        },

        selectedHistoryImageIndex() {
            this.queueSyncHistoryListDesktopHeight();
        },

        requestHistory: {
            deep: true,
            handler() {
                this.queueSyncHistoryListDesktopHeight();
            }
        }
    },

    methods: {
        // ========== 桌面历史列表高度同步 ==========
        isDesktopViewport() {
            if (typeof window === 'undefined') return false;
            if (window.matchMedia) {
                return window.matchMedia('(min-width: 992px)').matches;
            }
            return window.innerWidth >= 992;
        },

        onWindowResize() {
            this.queueSyncHistoryListDesktopHeight();
        },

        queueSyncHistoryListDesktopHeight() {
            if (this._historyListDesktopRaf) {
                cancelAnimationFrame(this._historyListDesktopRaf);
                this._historyListDesktopRaf = null;
            }

            this._historyListDesktopRaf = requestAnimationFrame(() => {
                this._historyListDesktopRaf = null;
                this.syncHistoryListDesktopHeight();
            });
        },

        syncHistoryListDesktopHeight() {
            if (!this.isDesktopViewport() || this.resultsTab !== 'history') {
                this.historyListDesktopMaxHeight = 0;
                return;
            }

            const rightBody = this.$refs.historyDetailDesktopBody || this.$refs.historyDetailDesktop;
            if (!rightBody || !rightBody.getBoundingClientRect) {
                this.historyListDesktopMaxHeight = 0;
                return;
            }

            const rect = rightBody.getBoundingClientRect();
            const h = Math.floor(rect.height || 0);
            if (h > 0) {
                this.historyListDesktopMaxHeight = h;
                return;
            }

            this.historyListDesktopMaxHeight = 0;
        },

        // ========== 自定义通知 / 确认弹窗 ==========
        getUiNoticeIcon(type) {
            if (type === 'success') return 'bi-check-circle-fill';
            if (type === 'warning') return 'bi-exclamation-triangle-fill';
            if (type === 'danger') return 'bi-x-circle-fill';
            return 'bi-info-circle-fill';
        },

        showUiToast(message, type = 'info', duration = 1800) {
            const text = String(message || '').trim();
            if (!text) return;

            this.uiToast.show = true;
            this.uiToast.message = text;
            this.uiToast.type = type;

            if (this._uiToastTimer) {
                clearTimeout(this._uiToastTimer);
                this._uiToastTimer = null;
            }

            this._uiToastTimer = setTimeout(() => {
                this.uiToast.show = false;
                this._uiToastTimer = null;
            }, Math.max(800, Number(duration) || 1800));
        },

        hideUiToast() {
            if (this._uiToastTimer) {
                clearTimeout(this._uiToastTimer);
                this._uiToastTimer = null;
            }
            this.uiToast.show = false;
        },

        openUiDialog(options) {
            const opt = options || {};

            if (this._uiDialogResolver) {
                this._uiDialogResolver(false);
                this._uiDialogResolver = null;
            }

            this.uiDialog.title = String(opt.title || (opt.showCancel ? '请确认' : '提示'));
            this.uiDialog.message = String(opt.message || '');
            this.uiDialog.type = opt.type || (opt.showCancel ? 'warning' : 'info');
            this.uiDialog.showCancel = !!opt.showCancel;
            this.uiDialog.confirmText = String(opt.confirmText || '确定');
            this.uiDialog.cancelText = String(opt.cancelText || '取消');
            this.uiDialog.show = true;

            return new Promise((resolve) => {
                this._uiDialogResolver = resolve;
            });
        },

        async askConfirm(message, options) {
            const opt = options || {};
            return this.openUiDialog({
                title: opt.title || '请确认',
                message,
                type: opt.type || 'warning',
                showCancel: true,
                confirmText: opt.confirmText || '确定',
                cancelText: opt.cancelText || '取消'
            });
        },

        async showUiAlert(message, options) {
            const opt = options || {};
            await this.openUiDialog({
                title: opt.title || '提示',
                message,
                type: opt.type || 'info',
                showCancel: false,
                confirmText: opt.confirmText || '知道了'
            });
        },

        resolveUiDialog(confirmed) {
            const resolver = this._uiDialogResolver;
            this._uiDialogResolver = null;
            this.uiDialog.show = false;
            if (resolver) {
                resolver(!!confirmed);
            }
        },

        onUiDialogBackdropClick() {
            if (!this.uiDialog.show) return;
            this.resolveUiDialog(!this.uiDialog.showCancel);
        },

        // ========== Workflow 图与受控编辑 ==========
        queueWorkflowGraphRender() {
            if (this._workflowGraphRaf) return;
            this._workflowGraphRaf = requestAnimationFrame(() => {
                this._workflowGraphRaf = null;
                this.renderWorkflowGraph();
            });
        },

        renderWorkflowGraph() {
            const container = this.$refs.workflowGraph;
            if (!container || this.workflowView !== 'graph' || !window.cytoscape) return;

            const graph = this.workflowGraph;
            if (this._workflowCy) {
                this._workflowCy.destroy();
                this._workflowCy = null;
            }

            if (graph.nodes.length === 0) return;

            const elements = [
                ...graph.nodes.map(node => ({
                    data: {
                        id: node.id,
                        label: node.title,
                        type: node.classType,
                        category: node.category
                    }
                })),
                ...graph.edges.map(edge => ({
                    data: {
                        id: edge.id,
                        source: edge.sourceNodeId,
                        target: edge.targetNodeId,
                        input: edge.targetInputName
                    }
                }))
            ];

            this._workflowCy = window.cytoscape({
                container,
                elements,
                minZoom: 0.25,
                maxZoom: 2.5,
                style: [
                    {
                        selector: 'node',
                        style: {
                            'background-color': '#34495e',
                            'border-width': 1,
                            'border-color': '#93a4b8',
                            'label': 'data(label)',
                            'color': '#f8f9fa',
                            'font-size': 12,
                            'text-wrap': 'wrap',
                            'text-max-width': 132,
                            'text-valign': 'center',
                            'text-halign': 'center',
                            'width': 166,
                            'height': 58,
                            'padding': 8,
                            'shape': 'round-rectangle'
                        }
                    },
                    { selector: 'node[category = "loader"]', style: { 'background-color': '#176b87' } },
                    { selector: 'node[category = "conditioning"]', style: { 'background-color': '#80651c' } },
                    { selector: 'node[category = "sampler"]', style: { 'background-color': '#3b5c9a' } },
                    { selector: 'node[category = "latent"]', style: { 'background-color': '#704488' } },
                    { selector: 'node[category = "decode"]', style: { 'background-color': '#386b55' } },
                    { selector: 'node[category = "output"]', style: { 'background-color': '#8a4a32' } },
                    { selector: 'node[category = "lora"]', style: { 'background-color': '#855d1c' } },
                    {
                        selector: 'edge',
                        style: {
                            'curve-style': 'bezier',
                            'target-arrow-shape': 'triangle',
                            'line-color': '#8293a8',
                            'target-arrow-color': '#8293a8',
                            'width': 2
                        }
                    },
                    {
                        selector: 'node:selected',
                        style: {
                            'border-width': 3,
                            'border-color': '#6ea8fe',
                            'overlay-color': '#6ea8fe',
                            'overlay-opacity': 0.12
                        }
                    }
                ],
                layout: {
                    name: window.cytoscapeDagre ? 'dagre' : 'breadthfirst',
                    rankDir: 'LR',
                    nodeSep: 48,
                    rankSep: 86,
                    padding: 28,
                    directed: true,
                    fit: true
                }
            });

            this._workflowCy.on('tap', 'node', event => {
                this.selectWorkflowNode(event.target.id());
            });

            if (this.selectedWorkflowNodeId) {
                const selected = this._workflowCy.getElementById(this.selectedWorkflowNodeId);
                if (selected.length > 0) selected.select();
            }
        },

        selectWorkflowNode(nodeId) {
            this.selectedWorkflowNodeId = String(nodeId || '');
            if (!this._workflowCy) return;
            this._workflowCy.nodes().unselect();
            const node = this._workflowCy.getElementById(this.selectedWorkflowNodeId);
            if (node.length > 0) {
                node.select();
                this._workflowCy.animate({ center: { eles: node }, duration: 180 });
            }
        },

        workflowGraphFit() {
            if (this._workflowCy) this._workflowCy.fit(undefined, 28);
        },

        workflowGraphZoom(delta) {
            if (!this._workflowCy) return;
            const current = this._workflowCy.zoom();
            this._workflowCy.zoom({ level: Math.max(0.25, Math.min(2.5, current + delta)), renderedPosition: {
                x: this._workflowCy.width() / 2,
                y: this._workflowCy.height() / 2
            } });
        },

        getWorkflowInputBinding(nodeId, inputName) {
            return WorkflowEditor.getBindingForInput(
                this.workflowObj,
                this.workflowEditorMeta,
                nodeId,
                inputName
            );
        },

        isWorkflowLoaderFilename(nodeId, inputName) {
            const roles = this.workflowEditorMeta.roles || {};
            return ['modelLoader', 'clipLoader', 'vaeLoader'].some(roleName => {
                const role = roles[roleName];
                return role && String(role.nodeId) === String(nodeId) && role.filenameInput === inputName;
            });
        },

        updateWorkflowPrimitiveInput(nodeId, inputName, value) {
            try {
                const next = WorkflowEditor.setInput(this.workflowObj, nodeId, inputName, value);
                this.workflowJson = JSON.stringify(next, null, 2);
                this.isWorkflowEditorDirty = true;
            } catch (e) {
                this.showUiToast(e.message, 'danger');
            }
        },

        startExposeWorkflowInput(nodeId, inputName, value) {
            const binding = this.getWorkflowInputBinding(nodeId, inputName);
            if (binding) {
                this.showUiToast('该字段已经加入参数', 'info');
                return;
            }

            const baseId = String(inputName).replace(/[^A-Za-z0-9_]/g, '_') || 'parameter';
            const existingIds = this.workflowParameterBindings.map(item => item.id);
            const idRoot = /^[A-Za-z_]/.test(baseId) ? baseId : `param_${baseId}`;
            let id = idRoot;
            let suffix = 2;
            while (existingIds.includes(id)) id = `${idRoot}_${suffix++}`;

            const known = PlaceholderEngine.KNOWN_PLACEHOLDERS
                && PlaceholderEngine.KNOWN_PLACEHOLDERS[id];
            this.pendingExposeInput = { nodeId: String(nodeId), inputName, value };
            this.exposeForm = {
                id,
                label: known ? known.label : inputName,
                control: known ? known.type : WorkflowEditor.inferControl(value),
                min: known && known.min !== undefined ? known.min : '',
                max: known && known.max !== undefined ? known.max : '',
                step: known && known.step !== undefined ? known.step : ''
            };
        },

        cancelExposeWorkflowInput() {
            this.pendingExposeInput = null;
        },

        confirmExposeWorkflowInput() {
            if (!this.pendingExposeInput) return;
            try {
                const result = WorkflowEditor.exposeInput(
                    this.workflowObj,
                    this.workflowEditorMeta,
                    { ...this.pendingExposeInput, ...this.exposeForm }
                );
                this.workflowEditorMeta = result.editor;
                this.placeholderValues = {
                    ...this.placeholderValues,
                    [result.binding.id]: result.initialValue
                };
                this.workflowJson = JSON.stringify(result.workflow, null, 2);
                this.isWorkflowEditorDirty = true;
                this.pendingExposeInput = null;
                this.showUiToast(`已加入参数：${result.binding.label}`, 'success');
            } catch (e) {
                this.showUiToast(e.message, 'danger');
            }
        },

        removeWorkflowParameter(parameterId) {
            const value = this.placeholderValues && this.placeholderValues[parameterId];
            try {
                const result = WorkflowEditor.removeBinding(
                    this.workflowObj,
                    this.workflowEditorMeta,
                    parameterId,
                    value
                );
                this.workflowEditorMeta = result.editor;
                const nextValues = { ...(this.placeholderValues || {}) };
                delete nextValues[parameterId];
                this.placeholderValues = nextValues;
                this.workflowJson = JSON.stringify(result.workflow, null, 2);
                this.isWorkflowEditorDirty = true;
                this.showUiToast('参数已移除，字段已恢复为当前值', 'info');
            } catch (e) {
                this.showUiToast(e.message, 'danger');
            }
        },

        focusWorkflowParameter(parameterId) {
            const binding = this.workflowParameterBindings.find(item => item.id === parameterId);
            if (!binding) return;
            this.workflowView = 'graph';
            this.$nextTick(() => this.selectWorkflowNode(binding.nodeId));
        },

        addWorkflowLora() {
            if (!this.canEditLoraChain) {
                this.showUiToast('当前模板不支持受控 LoRA 编辑', 'warning');
                return;
            }
            this.loraDrafts.push({ name: '', strengthModel: 1, strengthClip: 1 });
            this.applyWorkflowLoraDrafts();
        },

        removeWorkflowLora(index) {
            this.loraDrafts.splice(index, 1);
            this.applyWorkflowLoraDrafts();
        },

        moveWorkflowLora(index, direction) {
            const nextIndex = index + direction;
            if (nextIndex < 0 || nextIndex >= this.loraDrafts.length) return;
            const items = this.loraDrafts.slice();
            const [item] = items.splice(index, 1);
            items.splice(nextIndex, 0, item);
            this.loraDrafts = items;
            this.applyWorkflowLoraDrafts();
        },

        applyWorkflowLoraDrafts() {
            if (!this.canEditLoraChain) return;
            try {
                const result = WorkflowEditor.syncLoraChain(
                    this.workflowObj,
                    this.workflowEditorMeta,
                    this.loraDrafts
                );
                this.loraDrafts = result.loras;
                this.workflowJson = JSON.stringify(result.workflow, null, 2);
                this.isWorkflowEditorDirty = true;
            } catch (e) {
                this.showUiToast(e.message, 'danger');
            }
        },

        syncWorkflowEditorState(workflow) {
            this.loraDrafts = WorkflowEditor.readManagedLoras(workflow);
            const graph = WorkflowEditor.parse(workflow);
            if (!graph.nodes.some(node => node.id === this.selectedWorkflowNodeId)) {
                this.selectedWorkflowNodeId = graph.nodes[0] ? graph.nodes[0].id : '';
            }
            this.queueWorkflowGraphRender();
        },

        // ========== Workflow 解析 ==========
        parseWorkflow() {
            this.workflowError = '';
            this.workflowObj = null;
            this.placeholders = [];

            if (!this.workflowJson.trim()) return;

            try {
                let parsed = JSON.parse(this.workflowJson);

                // 如果外层有 input.workflow，提取内部
                if (parsed.input && parsed.input.workflow) {
                    parsed = parsed.input.workflow;
                    this.workflowJson = JSON.stringify(parsed, null, 2);
                    return; // 重新触发 watch
                }

                this.workflowObj = parsed;

                // 扫描占位符，并优先使用模板保存的节点字段/控件元数据
                const bindings = WorkflowEditor.mergeParameterBindings(parsed, this.workflowEditorMeta);
                this.placeholders = PlaceholderEngine.scan(parsed).map(placeholder => {
                    const binding = bindings.find(item => item.id === placeholder.name);
                    if (!binding) return placeholder;
                    return {
                        ...placeholder,
                        ...binding,
                        name: placeholder.name,
                        type: binding.control || placeholder.type,
                        default: binding.defaultValue !== undefined
                            ? binding.defaultValue
                            : placeholder.default
                    };
                });

                // 设置默认值
                const defaults = PlaceholderEngine.getDefaults(this.placeholders);
                const merged = { ...defaults };
                const cur = this.placeholderValues || {};
                Object.keys(cur).forEach(key => {
                    if (Object.prototype.hasOwnProperty.call(merged, key)) {
                        merged[key] = cur[key];
                    }
                });
                this.placeholderValues = merged;

                // 如果有模板且模板有 defaults，优先使用模板的
                if (this.selectedTemplate && this.selectedTemplate.defaults) {
                    Object.keys(this.selectedTemplate.defaults).forEach(key => {
                        if (key === 'prompt' || key === 'negative_prompt' || key === 'input_image') return;
                        if (this.placeholderValues.hasOwnProperty(key)) {
                            this.placeholderValues[key] = this.selectedTemplate.defaults[key];
                        }
                    });
                }

                // 模板切换：优先恢复该模板自己的草稿，否则使用模板默认值
                if (this._pendingTemplateDraft) {
                    const draft = this._pendingTemplateDraft;
                    const next = { ...(this.placeholderValues || {}) };
                    Object.keys(draft).forEach(key => {
                        if (Object.prototype.hasOwnProperty.call(next, key)) next[key] = draft[key];
                    });
                    this.placeholderValues = next;
                    this._pendingTemplateDraft = null;
                }

                this.applyLastPlaceholderValuesIfNeeded();

                this.validatePlaceholders();
                this.onSizeChange();
                this.syncWorkflowEditorState(parsed);

            } catch (e) {
                this.workflowError = 'JSON 格式错误: ' + e.message;

                // 即使 JSON 暂时无效，也尽量从文本中扫描占位符，方便用户先填参数
                const bindings = WorkflowEditor.mergeParameterBindings(null, this.workflowEditorMeta);
                this.placeholders = PlaceholderEngine.scanText(this.workflowJson).map(placeholder => {
                    const binding = bindings.find(item => item.id === placeholder.name);
                    if (!binding) return placeholder;
                    return {
                        ...placeholder,
                        ...binding,
                        name: placeholder.name,
                        type: binding.control || placeholder.type,
                        default: binding.defaultValue !== undefined
                            ? binding.defaultValue
                            : placeholder.default
                    };
                });

                const defaults = PlaceholderEngine.getDefaults(this.placeholders);
                const merged = { ...defaults };
                const cur = this.placeholderValues || {};
                Object.keys(cur).forEach(key => {
                    if (Object.prototype.hasOwnProperty.call(merged, key)) {
                        merged[key] = cur[key];
                    }
                });
                this.placeholderValues = merged;

                if (this.selectedTemplate && this.selectedTemplate.defaults) {
                    Object.keys(this.selectedTemplate.defaults).forEach(key => {
                        if (key === 'prompt' || key === 'negative_prompt' || key === 'input_image') return;
                        if (this.placeholderValues.hasOwnProperty(key)) {
                            this.placeholderValues[key] = this.selectedTemplate.defaults[key];
                        }
                    });
                }

                if (this._pendingTemplateDraft) {
                    const draft = this._pendingTemplateDraft;
                    const next = { ...(this.placeholderValues || {}) };
                    Object.keys(draft).forEach(key => {
                        if (Object.prototype.hasOwnProperty.call(next, key)) next[key] = draft[key];
                    });
                    this.placeholderValues = next;
                    this._pendingTemplateDraft = null;
                }

                this.applyLastPlaceholderValuesIfNeeded();

                this.validatePlaceholders();
                this.onSizeChange();
            }
        },

        validatePlaceholders() {
            const result = PlaceholderEngine.validate(this.placeholders, this.placeholderValues);
            this.placeholderErrors = Object.values(result.errors);
        },

        // ========== Seed 随机化 ==========
        generateRandomSeed() {
            // 0..2147483647
            try {
                if (window.crypto && window.crypto.getRandomValues) {
                    const arr = new Uint32Array(1);
                    window.crypto.getRandomValues(arr);
                    return (arr[0] & 0x7fffffff);
                }
            } catch (e) {
                // ignore
            }
            return Math.floor(Math.random() * 2147483648);
        },

        randomizeSeedOnce() {
            if (!this.hasSeedPlaceholder) return;
            this.placeholderValues.seed = this.generateRandomSeed();
        },

        // ========== 输入状态持久化（刷新恢复） ==========
        loadLastPlaceholderValuesDraft() {
            const KEY = 'runpod_last_placeholder_values_v1';
            this._pendingLastPlaceholderValues = null;
            this._didApplyLastPlaceholderValues = false;

            let parsed = null;
            try {
                const raw = localStorage.getItem(KEY);
                if (!raw) return;
                parsed = this.safeJsonParse(raw, null);
            } catch (e) {
                parsed = null;
            }

            if (!parsed || typeof parsed !== 'object') return;
            const values = parsed.values && typeof parsed.values === 'object' ? parsed.values : null;
            if (!values) return;

            this._pendingLastPlaceholderValues = values;
        },

        applyLastPlaceholderValuesIfNeeded() {
            if (this._didApplyLastPlaceholderValues) return false;
            const pending = this._pendingLastPlaceholderValues;
            if (!pending || typeof pending !== 'object') return false;
            if (!Array.isArray(this.placeholders) || this.placeholders.length === 0) return false;

            const allowed = new Set(this.placeholders.map(p => p.name));
            const next = { ...(this.placeholderValues || {}) };

            Object.keys(pending).forEach(k => {
                if (!allowed.has(k)) return;
                next[k] = deepCloneJson(pending[k]);
            });

            this.placeholderValues = next;
            this._pendingLastPlaceholderValues = null;
            this._didApplyLastPlaceholderValues = true;
            return true;
        },

        queuePersistLastPlaceholderValues() {
            if (this._lastPlaceholderPersistTimer) {
                clearTimeout(this._lastPlaceholderPersistTimer);
                this._lastPlaceholderPersistTimer = null;
            }

            // 当 workflow 尚未解析出占位符时，不写入，避免覆盖为 "空"
            if (!Array.isArray(this.placeholders) || this.placeholders.length === 0) return;

            this._lastPlaceholderPersistTimer = setTimeout(() => {
                this._lastPlaceholderPersistTimer = null;
                this.persistLastPlaceholderValuesNow();
            }, 600);
        },

        persistLastPlaceholderValuesNow() {
            const KEY = 'runpod_last_placeholder_values_v1';
            if (!Array.isArray(this.placeholders) || this.placeholders.length === 0) return;

            const allowed = new Set(this.placeholders.map(p => p.name));
            const values = {};
            const cur = this.placeholderValues || {};
            Object.keys(cur).forEach(k => {
                if (!allowed.has(k)) return;
                values[k] = cur[k];
            });

            try {
                localStorage.setItem(KEY, JSON.stringify({
                    updatedAt: Date.now(),
                    templateId: this.selectedTemplateId || '',
                    values
                }));
                this.persistTemplateDraftFor(this.selectedTemplateId, values);
            } catch (e) {
                // ignore
            }
        },

        loadWorkflowCollapsedState() {
            const KEY = 'runpod_workflow_collapsed_v1';
            try {
                const raw = localStorage.getItem(KEY);
                if (!raw) return;
                const parsed = this.safeJsonParse(raw, null);
                if (typeof parsed === 'boolean') {
                    this.isWorkflowCollapsed = parsed;
                } else if (parsed && typeof parsed === 'object' && typeof parsed.value === 'boolean') {
                    this.isWorkflowCollapsed = parsed.value;
                }
            } catch (e) {
                // ignore
            }
        },

        persistWorkflowCollapsedState() {
            const KEY = 'runpod_workflow_collapsed_v1';
            try {
                localStorage.setItem(KEY, JSON.stringify({ value: !!this.isWorkflowCollapsed }));
            } catch (e) {
                // ignore
            }
        },

        loadSeedRandomEachRunState() {
            const KEY = 'runpod_seed_random_each_run_v1';
            try {
                const raw = localStorage.getItem(KEY);
                if (!raw) return;
                const parsed = this.safeJsonParse(raw, null);
                if (typeof parsed === 'boolean') {
                    this.seedRandomEachRun = parsed;
                } else if (parsed && typeof parsed === 'object' && typeof parsed.value === 'boolean') {
                    this.seedRandomEachRun = parsed.value;
                }
            } catch (e) {
                // ignore
            }
        },

        persistSeedRandomEachRunState() {
            const KEY = 'runpod_seed_random_each_run_v1';
            try {
                localStorage.setItem(KEY, JSON.stringify({ value: !!this.seedRandomEachRun }));
            } catch (e) {
                // ignore
            }
        },

        // ========== 提示词预设 ==========
        loadPromptInsertOptions() {
            const raw = localStorage.getItem('runpod_prompt_insert_options_v1');
            if (!raw) return;
            const parsed = this.safeJsonParse(raw, null);
            if (!parsed || typeof parsed !== 'object') return;

            const keepUnderscore = parsed.keepUnderscore;
            const escapeParentheses = parsed.escapeParentheses;
            const keepAtPrefix = parsed.keepAtPrefix;
            if (typeof keepUnderscore === 'boolean') this.promptInsertOptions.keepUnderscore = keepUnderscore;
            if (typeof escapeParentheses === 'boolean') this.promptInsertOptions.escapeParentheses = escapeParentheses;
            if (typeof keepAtPrefix === 'boolean') this.promptInsertOptions.keepAtPrefix = keepAtPrefix;
        },

        persistPromptInsertOptions() {
            try {
                localStorage.setItem('runpod_prompt_insert_options_v1', JSON.stringify({
                    keepUnderscore: !!this.promptInsertOptions.keepUnderscore,
                    escapeParentheses: !!this.promptInsertOptions.escapeParentheses,
                    keepAtPrefix: !!this.promptInsertOptions.keepAtPrefix
                }));
            } catch (e) {
                // ignore
            }
        },

        togglePromptRefs() {
            // 打开参考站点时确保提示词区展开，避免面板被折叠隐藏
            if (this.paramSectionsOpen && this.paramSectionsOpen.prompt === false) {
                this.paramSectionsOpen = { ...this.paramSectionsOpen, prompt: true };
                this.persistParamSectionsOpenState();
            }
            this.showPromptRefs = !this.showPromptRefs;
        },

        preloadTagIndexes() {
            const run = () => {
                if (!window.TagIndex || !window.TagIndex.ensureLoaded) return;
                window.TagIndex.ensureLoaded()
                    .then(() => window.TagIndex.ensureZhLoaded())
                    .catch(() => {});
            };
            if (typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(run, { timeout: 3000 });
            } else {
                setTimeout(run, 1200);
            }
        },

        togglePromptInputOptions() {
            // 如果提示词模块被收起，先展开，避免用户找不到选项
            if (this.paramSectionsOpen && this.paramSectionsOpen.prompt === false) {
                this.paramSectionsOpen = { ...this.paramSectionsOpen, prompt: true };
                this.persistParamSectionsOpenState();
            }
            this.showPromptInputOptions = !this.showPromptInputOptions;
        },

        safeJsonParse(text, fallback) {
            try {
                const parsed = JSON.parse(text);
                return parsed;
            } catch (e) {
                return fallback;
            }
        },

        setPromptPresetMessage(text, type) {
            this.promptPresetMessage = text || '';
            this.promptPresetMessageType = type || '';

            if (this._promptPresetMsgTimer) {
                clearTimeout(this._promptPresetMsgTimer);
                this._promptPresetMsgTimer = null;
            }

            if (this.promptPresetMessage) {
                this._promptPresetMsgTimer = setTimeout(() => {
                    this.promptPresetMessage = '';
                    this.promptPresetMessageType = '';
                    this._promptPresetMsgTimer = null;
                }, 1600);
            }
        },

        loadPromptPresets() {
            const blocksRaw = localStorage.getItem('runpod_prompt_block_presets_v1') || '[]';
            const snippetsRaw = localStorage.getItem('runpod_prompt_snippet_presets_v1') || '[]';

            const blocks = this.safeJsonParse(blocksRaw, []);
            const snippets = this.safeJsonParse(snippetsRaw, []);

            this.promptBlockPresets = Array.isArray(blocks) ? blocks.filter(p => p && p.id && p.name) : [];
            this.promptSnippetPresets = Array.isArray(snippets) ? snippets.filter(s => s && s.id && s.name) : [];

            // localStorage 不可信：只保留站内 revision 预览路径，外链/坏结构直接丢弃
            this.promptBlockPresets = this.promptBlockPresets.map(p => ({
                ...p,
                preview: CatalogClient.normalizePreview(p.preview)
            }));
            this.promptSnippetPresets = this.promptSnippetPresets.map(s => ({
                ...s,
                preview: CatalogClient.normalizePreview(s.preview)
            }));

            // 最新在前
            this.promptBlockPresets.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
            this.promptSnippetPresets.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
        },

        persistPromptPresets() {
            try {
                localStorage.setItem('runpod_prompt_block_presets_v1', JSON.stringify(this.promptBlockPresets || []));
                localStorage.setItem('runpod_prompt_snippet_presets_v1', JSON.stringify(this.promptSnippetPresets || []));
            } catch (e) {
                this.setPromptPresetMessage('保存失败：存储空间不足或浏览器限制', 'danger');
            }
        },

        openPromptPresets() {
            this.loadPromptPresets();
            this.promptPresetTab = 'blocks';
            this.promptPresetSearch = '';
            this.showPromptPresets = true;
        },

        closePromptPresets() {
            this.showPromptPresets = false;
        },

        async saveCurrentAsBlockPreset() {
            const name = (this.newPromptBlockName || '').trim();
            if (!name) {
                this.setPromptPresetMessage('请输入预设名称', 'warning');
                return;
            }

            const promptVal = this.placeholderValues && this.placeholderValues.prompt !== undefined
                ? String(this.placeholderValues.prompt || '')
                : '';
            const negVal = this.placeholderValues && this.placeholderValues.negative_prompt !== undefined
                ? String(this.placeholderValues.negative_prompt || '')
                : '';

            const existing = (this.promptBlockPresets || []).find(p => p && p.name === name);
            const now = Date.now();

            if (existing) {
                const shouldOverwrite = await this.askConfirm('已存在同名预设，是否覆盖更新？', {
                    title: '覆盖确认',
                    type: 'warning'
                });
                if (!shouldOverwrite) return;
                existing.prompt = promptVal;
                existing.negative_prompt = negVal;
                existing.updatedAt = now;
                this.persistPromptPresets();
                this.newPromptBlockName = '';
                this.setPromptPresetMessage('已更新整块预设', 'success');
                return;
            }

            const preset = {
                id: generateLocalId('pb'),
                name,
                prompt: promptVal,
                negative_prompt: negVal,
                createdAt: now,
                updatedAt: now
            };

            this.promptBlockPresets = [preset, ...(this.promptBlockPresets || [])].slice(0, 60);
            this.persistPromptPresets();
            this.newPromptBlockName = '';
            this.setPromptPresetMessage('已保存整块预设', 'success');
        },

        applyBlockPreset(p) {
            if (!p) return;
            this.applyPromptPresetContent({
                positive: p.prompt,
                negative: p.negative_prompt,
                label: `预设「${p.name || '未命名'}」`
            });
            this.appliedBlockPresetId = p.id;
            this.setPromptPresetMessage('已应用预设', 'success');
        },

        updateBlockPreset(p) {
            if (!p || !p.id) return;
            const now = Date.now();

            p.prompt = this.placeholderValues && this.placeholderValues.prompt !== undefined
                ? String(this.placeholderValues.prompt || '')
                : '';
            p.negative_prompt = this.placeholderValues && this.placeholderValues.negative_prompt !== undefined
                ? String(this.placeholderValues.negative_prompt || '')
                : '';
            p.updatedAt = now;

            this.promptBlockPresets.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            this.persistPromptPresets();
            this.setPromptPresetMessage('已更新预设内容', 'success');
        },

        async deleteBlockPreset(p) {
            if (!p || !p.id) return;
            const ok = await this.askConfirm(`确定要删除预设 “${p.name}” 吗？`, {
                title: '删除确认',
                type: 'danger'
            });
            if (!ok) return;
            this.promptBlockPresets = (this.promptBlockPresets || []).filter(x => x && x.id !== p.id);
            this.persistPromptPresets();
            this.setPromptPresetMessage('已删除预设', 'success');
        },

        fillSnippetFromCurrent(field) {
            const f = field === 'negative_prompt' ? 'negative_prompt' : 'prompt';
            const text = this.placeholderValues && this.placeholderValues[f] !== undefined
                ? String(this.placeholderValues[f] || '')
                : '';
            this.newPromptSnippetText = text;
            if (!(this.newPromptSnippetName || '').trim()) {
                const label = f === 'negative_prompt' ? '负向' : '正向';
                this.newPromptSnippetName = `${label}_${new Date().toLocaleString()}`;
            }

            const label = f === 'negative_prompt' ? '已从负向填充' : '已从正向填充';
            this.setPromptPresetMessage(label, 'success');
        },

        async saveSnippetPreset() {
            const name = (this.newPromptSnippetName || '').trim();
            const text = String(this.newPromptSnippetText || '').trim();
            if (!name) {
                this.setPromptPresetMessage('请输入片段名称', 'warning');
                return;
            }
            if (!text) {
                this.setPromptPresetMessage('请输入片段内容', 'warning');
                return;
            }

            const existing = (this.promptSnippetPresets || []).find(s => s && s.name === name);
            const now = Date.now();
            if (existing) {
                const shouldOverwrite = await this.askConfirm('已存在同名片段，是否覆盖更新？', {
                    title: '覆盖确认',
                    type: 'warning'
                });
                if (!shouldOverwrite) return;
                existing.text = text;
                existing.updatedAt = now;
                this.persistPromptPresets();
                this.newPromptSnippetName = '';
                this.newPromptSnippetText = '';
                this.setPromptPresetMessage('已更新片段', 'success');
                return;
            }

            const s = {
                id: generateLocalId('ps'),
                name,
                text,
                createdAt: now,
                updatedAt: now
            };
            this.promptSnippetPresets = [s, ...(this.promptSnippetPresets || [])].slice(0, 120);
            this.persistPromptPresets();
            this.newPromptSnippetName = '';
            this.newPromptSnippetText = '';
            this.setPromptPresetMessage('已保存片段', 'success');
        },

        async copyToClipboard(text) {
            const t = String(text || '');
            if (!t) return false;

            if (navigator.clipboard && navigator.clipboard.writeText) {
                try {
                    await navigator.clipboard.writeText(t);
                    return true;
                } catch (e) {
                    // fallback
                }
            }

            try {
                const ta = document.createElement('textarea');
                ta.value = t;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.left = '-10000px';
                ta.style.top = '0';
                document.body.appendChild(ta);
                ta.select();
                ta.setSelectionRange(0, t.length);
                const ok = document.execCommand('copy');
                document.body.removeChild(ta);
                return ok;
            } catch (e) {
                return false;
            }
        },

        async copyText(text, label) {
            const t = String(text || '');
            const name = label ? String(label) : '内容';
            if (!t.trim()) {
                this.showUiToast(`${name} 为空，无法复制。`, 'warning');
                return;
            }

            const ok = await this.copyToClipboard(t);
            if (!ok) {
                this.showUiToast('复制失败：浏览器权限限制', 'danger');
                return;
            }

            this.showUiToast(`${name} 已复制`, 'success');
        },

        async copySnippet(text) {
            const ok = await this.copyToClipboard(text);
            if (ok) {
                this.setPromptPresetMessage('已复制到剪贴板', 'success');
            } else {
                this.setPromptPresetMessage('复制失败：浏览器权限限制', 'danger');
            }
        },

        insertSnippetToPrompt(s, field) {
            if (!s || !s.text) return;
            const f = field === 'negative_prompt' ? 'negative_prompt' : 'prompt';
            const ok = this.insertSnippetText(String(s.text || ''), f, `片段「${s.name || '未命名'}」`);
            if (!ok) return;
            const label = f === 'negative_prompt' ? '负向' : '正向';
            this.setPromptPresetMessage(`已插入到${label}提示词`, 'success');
        },

        async deleteSnippetPreset(s) {
            if (!s || !s.id) return;
            const ok = await this.askConfirm(`确定要删除片段 “${s.name}” 吗？`, {
                title: '删除确认',
                type: 'danger'
            });
            if (!ok) return;
            this.promptSnippetPresets = (this.promptSnippetPresets || []).filter(x => x && x.id !== s.id);
            this.persistPromptPresets();
            this.setPromptPresetMessage('已删除片段', 'success');
        },

        // ========== 前台视图 / 资源库 ==========

        // 预览图（固定尺寸 / broken 回退）：带参数，必须注册为 methods
        previewDomKey(item) {
            if (!item) return '';
            const preview = item.preview || null;
            const rev = item.sourceRevision !== undefined && item.sourceRevision !== null
                ? item.sourceRevision
                : (item.publishedRevision !== undefined && item.publishedRevision !== null ? item.publishedRevision : '');
            return `${String(item.id || '')}@${rev}@${preview && preview.url ? preview.url : ''}`;
        },

        isPreviewBroken(item) {
            const key = this.previewDomKey(item);
            return !!(key && this.previewBroken && this.previewBroken[key]);
        },

        markPreviewBroken(item) {
            const key = this.previewDomKey(item);
            if (!key) return;
            this.previewBroken = { ...(this.previewBroken || {}), [key]: true };
        },

        switchMainView(view) {
            this.mainView = view === 'library' ? 'library' : 'generate';
        },

        openLocalFavorites() {
            this.openFavoritesPanel();
        },

        async loadCatalogIfNeeded(force) {
            if (this.libraryLoading) return;
            if (!force && (this.catalogStatus === 'ready' || this.catalogStatus === 'offline')) return;
            this.libraryLoading = true;
            this.catalogStatus = 'loading';
            this.catalogError = '';
            try {
                const result = await CatalogClient.fetchCatalog({ etag: force ? '' : this.catalogEtag });
                if (!result.notModified && result.catalog) {
                    this.catalogItems = result.catalog.items;
                    this.catalogVersion = result.catalog.catalogVersion;
                    this.catalogEtag = result.etag || '';
                    this.catalogSavedAt = Date.now();
                    this.catalogAliasMap = CatalogClient.updateAliasMap(this.catalogAliasMap, this.catalogItems);
                    CatalogClient.saveAliasMap(localStorage, this.catalogAliasMap);
                    CatalogClient.saveCache(localStorage, result.catalog, this.catalogSavedAt);
                    this.visibleBuiltinTemplates = CatalogClient.visibleBuiltinTemplates(
                        this.builtinTemplates, this.catalogAliasMap, true
                    );
                    this.catalogStatus = 'ready';
                } else {
                    this.catalogStatus = this.catalogVersion ? 'ready' : 'idle';
                }
            } catch (e) {
                const cached = CatalogClient.loadCache(localStorage);
                if (cached) {
                    this.catalogItems = cached.items;
                    this.catalogVersion = cached.catalogVersion;
                    this.catalogSavedAt = cached.savedAt;
                    this.catalogStatus = 'offline';
                    this.catalogError = '';
                    this.visibleBuiltinTemplates = CatalogClient.visibleBuiltinTemplates(
                        this.builtinTemplates, this.catalogAliasMap, false, cached.items
                    );
                } else {
                    this.catalogStatus = 'error';
                    this.catalogError = e && e.message ? e.message : '统一库加载失败';
                }
                // 任何失败都不影响内置/本地模板继续使用
            } finally {
                this.libraryLoading = false;
            }
        },

        async loadCatalogDetail(id, publishedRevision) {
            if (!id) throw new Error('缺少资源 ID');
            const cached = this.catalogDetails[id];
            const expected = publishedRevision === undefined || publishedRevision === null ? null : Number(publishedRevision);
            if (cached && (expected === null || Number(cached.publishedRevision) === expected)) return cached;
            const diskCached = expected === null ? null : CatalogClient.getCachedDetail(localStorage, id, expected);
            if (diskCached) {
                this.catalogDetails = { ...this.catalogDetails, [id]: diskCached };
                return diskCached;
            }
            this.libraryDetailLoadingId = id;
            try {
                const detail = await CatalogClient.fetchCatalogDetail(id);
                this.catalogDetails = { ...this.catalogDetails, [id]: detail };
                CatalogClient.saveDetailCache(localStorage, detail);
                return detail;
            } catch (e) {
                if (cached && expected !== null && Number(cached.publishedRevision) === expected) return cached;
                if (diskCached) return diskCached;
                throw e;
            } finally {
                this.libraryDetailLoadingId = '';
            }
        },

        async useLibraryItem(item) {
            if (!item) return;
            const source = CatalogClient.sourceOf(item);
            if (source === 'local') return this.useLocalLibraryItem(item);
            if (item.kind === 'template') return this.useCatalogTemplate(item);
            if (item.kind === 'preset') return this.useCatalogPreset(item);
            return this.useCatalogSnippet(item);
        },

        // 本地资源只读本地记录：local:* 在服务端不存在，绝不请求共享详情
        useLocalLibraryItem(item) {
            const id = String(item.id || '');
            if (item.kind === 'template') {
                const tpl = (this.userTemplates || []).find(t => t && t.id === id)
                    || TemplateManager.get(id);
                if (!tpl || !tpl.workflow) {
                    this.showUiToast('本地模板不存在或已删除', 'warning');
                    this.loadUserTemplates();
                    return;
                }
                this.mainView = 'generate';
                if (this.selectedTemplateId === tpl.id) {
                    this.applyTemplateToEditor(tpl);
                } else {
                    this.selectedTemplateId = tpl.id;
                }
                this.showUiToast('已载入本地模板', 'success');
                return;
            }
            if (item.kind === 'preset') {
                const preset = (this.promptBlockPresets || []).find(p => p && p.id === id);
                if (!preset) {
                    this.showUiToast('本地预设不存在或已删除', 'warning');
                    return;
                }
                this.applyPromptPresetContent({
                    positive: preset.prompt,
                    negative: preset.negative_prompt,
                    label: `本地预设「${preset.name || '未命名'}」`
                });
                this.mainView = 'generate';
                this.showUiToast('已替换提示词', 'success');
                return;
            }
            const snippet = (this.promptSnippetPresets || []).find(s => s && s.id === id);
            if (!snippet) {
                this.showUiToast('本地片段不存在或已删除', 'warning');
                return;
            }
            const ok = this.insertSnippetToPrompt(
                snippet,
                snippet.target === 'negative' ? 'negative_prompt' : 'prompt'
            );
            if (ok !== false) this.mainView = 'generate';
        },

        buildSharedTemplate(detail) {
            const data = (detail && detail.data) || {};
            return {
                id: detail.id,
                schemaVersion: Number(data.schemaVersion || 2),
                name: detail.name,
                description: detail.description,
                workflow: data.workflow,
                defaults: data.defaults || {},
                editor: data.editor || {},
                isBuiltin: false,
                source: 'shared',
                sourceId: detail.id,
                sourceRevision: detail.publishedRevision
            };
        },

        useCatalogTemplate(item) {
            if (!item || !item.id) return;
            this.mainView = 'generate';
            if (this.selectedTemplateId === item.id) return this.onTemplateSelect();
            this.selectedTemplateId = item.id;
        },

        async useCatalogPreset(item) {
            try {
                const detail = await this.loadCatalogDetail(item.id, item.publishedRevision);
                const data = detail.data || {};
                this.applyPromptPresetContent({
                    positive: data.positive,
                    negative: data.negative,
                    label: `统一库预设「${detail.name}」`
                });
                this.mainView = 'generate';
                this.showUiToast('已替换提示词', 'success');
            } catch (e) {
                this.catalogError = e && e.message ? e.message : '预设载入失败';
                this.showUiToast(this.catalogError, 'danger');
            }
        },

        async useCatalogSnippet(item) {
            try {
                const detail = await this.loadCatalogDetail(item.id, item.publishedRevision);
                const data = detail.data || {};
                const target = data.target === 'negative' ? 'negative_prompt' : 'prompt';
                const ok = this.insertSnippetText(data.text, target, `统一库片段「${detail.name}」`);
                if (ok) this.mainView = 'generate';
            } catch (e) {
                this.catalogError = e && e.message ? e.message : '片段载入失败';
                this.showUiToast(this.catalogError, 'danger');
            }
        },

        async copyLibraryItemToLocal(item) {
            if (!item || CatalogClient.sourceOf(item) !== 'shared') return;
            try {
                const detail = await this.loadCatalogDetail(item.id, item.publishedRevision);
                if (item.kind === 'template') {
                    const names = (this.builtinTemplates || []).concat(this.userTemplates || []).map(t => t.name);
                    const name = CatalogClient.uniqueCopyName(detail.name, names);
                    const data = detail.data || {};
                    TemplateManager.add({
                        schemaVersion: Number(data.schemaVersion || 2),
                        name,
                        description: detail.description,
                        workflow: data.workflow,
                        defaults: data.defaults || {},
                        editor: data.editor || {},
                        source: 'local',
                        sourceId: detail.id,
                        sourceRevision: detail.publishedRevision,
                        preview: CatalogClient.pinPreview(detail.preview || item.preview, detail.id, detail.publishedRevision)
                    });
                    this.loadUserTemplates();
                } else if (item.kind === 'preset') {
                    const names = (this.promptBlockPresets || []).map(p => p.name);
                    const name = CatalogClient.uniqueCopyName(detail.name, names);
                    const data = detail.data || {};
                    this.promptBlockPresets = [{
                        id: CatalogClient.newLocalId('preset'),
                        name,
                        prompt: String(data.positive || ''),
                        negative_prompt: String(data.negative || ''),
                        source: 'local',
                        sourceId: detail.id,
                        sourceRevision: detail.publishedRevision,
                        preview: CatalogClient.pinPreview(detail.preview || item.preview, detail.id, detail.publishedRevision),
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    }, ...(this.promptBlockPresets || [])];
                    this.persistPromptPresets();
                } else {
                    const names = (this.promptSnippetPresets || []).map(s => s.name);
                    const name = CatalogClient.uniqueCopyName(detail.name, names);
                    const data = detail.data || {};
                    this.promptSnippetPresets = [{
                        id: CatalogClient.newLocalId('snippet'),
                        name,
                        text: String(data.text || ''),
                        target: data.target === 'negative' ? 'negative' : 'positive',
                        source: 'local',
                        sourceId: detail.id,
                        sourceRevision: detail.publishedRevision,
                        preview: CatalogClient.pinPreview(detail.preview || item.preview, detail.id, detail.publishedRevision),
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    }, ...(this.promptSnippetPresets || [])];
                    this.persistPromptPresets();
                }
                this.showUiToast('已复制到本地（不自动跟随后台更新）', 'success');
            } catch (e) {
                this.showUiToast(e && e.message ? e.message : '复制失败', 'danger');
            }
        },

        // ========== 提示词应用撤销 / 片段插入 ==========
        applyPromptPresetContent(content) {
            const values = this.placeholderValues || {};
            const next = { ...values };
            const hasPositive = Object.prototype.hasOwnProperty.call(next, 'prompt');
            const hasNegative = Object.prototype.hasOwnProperty.call(next, 'negative_prompt');
            if (!hasPositive && !hasNegative) {
                this.showUiToast('当前模板没有提示词占位符', 'warning');
                return false;
            }
            this.promptUndo = {
                prompt: hasPositive ? String(values.prompt || '') : undefined,
                negative_prompt: hasNegative ? String(values.negative_prompt || '') : undefined,
                label: String((content && content.label) || '预设')
            };
            if (hasPositive) next.prompt = String(content && content.positive || '');
            if (hasNegative) next.negative_prompt = String(content && content.negative || '');
            this.placeholderValues = next;
            return true;
        },

        undoPromptApply() {
            const undo = this.promptUndo;
            if (!undo) return;
            const next = { ...(this.placeholderValues || {}) };
            if (undo.prompt !== undefined) next.prompt = undo.prompt;
            if (undo.negative_prompt !== undefined) next.negative_prompt = undo.negative_prompt;
            this.placeholderValues = next;
            this.promptUndo = null;
            this.showUiToast('已撤销上次提示词应用', 'info');
        },

        recordPromptCaret(el) {
            if (!el || !el.dataset || !el.dataset.promptField) return;
            this.lastPromptField = el.dataset.promptField;
            this._lastPromptCaret = {
                field: el.dataset.promptField,
                start: Number.isFinite(el.selectionStart) ? el.selectionStart : 0,
                end: Number.isFinite(el.selectionEnd) ? el.selectionEnd : 0,
                el
            };
        },

        resolveSnippetField(targetField) {
            const field = targetField === 'negative_prompt' ? 'negative_prompt' : 'prompt';
            const record = this._lastPromptCaret;
            if (record && record.field && this.placeholderValues
                && Object.prototype.hasOwnProperty.call(this.placeholderValues, record.field)) {
                return record;
            }
            return null;
        },

        insertSnippetText(text, targetField, label) {
            const snippet = String(text || '').trim();
            if (!snippet) return false;
            const target = targetField === 'negative_prompt' ? 'negative_prompt' : 'prompt';
            const record = this.resolveSnippetField(target);
            const field = record ? record.field : target;
            if (!this.placeholderValues || !Object.prototype.hasOwnProperty.call(this.placeholderValues, field)) {
                this.showUiToast('当前模板没有可插入的提示词字段', 'warning');
                return false;
            }

            const values = { ...(this.placeholderValues || {}) };
            const before = String(values[field] || '');
            let start = record ? record.start : before.length;
            let end = record ? record.end : before.length;
            start = Math.max(0, Math.min(start, before.length));
            end = Math.max(start, Math.min(end, before.length));

            let insert = snippet;
            const leftRaw = before.slice(0, start);
            const rightRaw = before.slice(end);
            if (leftRaw && !/[,，\n]\s*$/.test(leftRaw)) insert = ', ' + insert;
            if (rightRaw && !/^\s*[,，\n]/.test(rightRaw)) insert = insert + ', ';
            const nextValue = before.slice(0, start) + insert + before.slice(end);
            const prevPrompt = String(values.prompt !== undefined ? values.prompt : '');
            const prevNegative = String(values.negative_prompt !== undefined ? values.negative_prompt : '');
            values[field] = nextValue;
            this.placeholderValues = values;

            const caret = start + insert.length;
            this._lastPromptCaret = record ? { ...record, start: caret, end: caret } : null;
            this.$nextTick(() => {
                const el = record && record.el && document.contains(record.el) ? record.el : null;
                if (el) {
                    el.focus();
                    try { el.setSelectionRange(caret, caret); } catch (e) { /* ignore */ }
                }
            });
            this.promptUndo = {
                prompt: Object.prototype.hasOwnProperty.call(values, 'prompt') ? prevPrompt : undefined,
                negative_prompt: Object.prototype.hasOwnProperty.call(values, 'negative_prompt') ? prevNegative : undefined,
                label: String(label || '片段')
            };
            if (label) this.showUiToast(`已应用${label}`, 'success');
            return true;
        },

        // ========== 模板草稿（按模板隔离） ==========
        templateDraftKey(templateId) {
            return templateId ? String(templateId) : '__custom__';
        },

        persistTemplateDraftFor(templateId, values) {
            if (!values || typeof values !== 'object') return;
            const map = CatalogClient.loadDraftMap(localStorage);
            const next = CatalogClient.saveDraftSnapshot(map, this.templateDraftKey(templateId), values);
            CatalogClient.saveDraftMap(localStorage, next);
        },

        loadTemplateDraftFor(templateId) {
            const map = CatalogClient.loadDraftMap(localStorage);
            // 过滤在新模板 placeholders 解析完成后进行，避免用旧模板字段裁剪草稿
            return CatalogClient.pickDraftSnapshot(map, this.templateDraftKey(templateId), null);
        },

        // ========== 本地资源操作（资源库） ==========
        openRenameLocalItem(item) {
            if (!item || CatalogClient.sourceOf(item) !== 'local') return;
            this.renameState = { show: true, id: item.id, kind: item.kind, value: item.name || '' };
        },

        confirmRenameLocalItem() {
            const state = this.renameState || {};
            const name = String(state.value || '').trim();
            if (!name) {
                this.showUiToast('名称不能为空', 'warning');
                return;
            }
            if (state.kind === 'template') {
                const tpl = (this.userTemplates || []).find(t => t.id === state.id);
                if (!tpl || !CatalogClient.canMutateLocal(tpl)) return;
                TemplateManager.update(state.id, { name });
                this.loadUserTemplates();
            } else if (state.kind === 'preset') {
                const preset = (this.promptBlockPresets || []).find(p => p.id === state.id);
                if (!preset || !CatalogClient.canMutateLocal(preset)) return;
                preset.name = name;
                preset.updatedAt = Date.now();
                this.persistPromptPresets();
            } else if (state.kind === 'snippet') {
                const snippet = (this.promptSnippetPresets || []).find(s => s.id === state.id);
                if (!snippet || !CatalogClient.canMutateLocal(snippet)) return;
                snippet.name = name;
                snippet.updatedAt = Date.now();
                this.persistPromptPresets();
            }
            this.renameState = { show: false, id: '', kind: '', value: '' };
            this.showUiToast('已重命名', 'success');
        },

        async deleteLibraryLocalItem(item) {
            if (!item || CatalogClient.sourceOf(item) !== 'local') return;
            const ok = await this.askConfirm(`确定删除本地${this.libraryKindLabel}「${item.name}」吗？`, {
                title: '删除确认',
                type: 'danger'
            });
            if (!ok) return;
            if (item.kind === 'template') {
                const tpl = (this.userTemplates || []).find(t => t.id === item.id);
                if (!tpl || !CatalogClient.canMutateLocal(tpl)) return;
                TemplateManager.delete(item.id);
                this.loadUserTemplates();
                if (this.selectedTemplateId === item.id) {
                    this.selectedTemplateId = '';
                    this.selectedTemplate = null;
                }
            } else if (item.kind === 'preset') {
                this.promptBlockPresets = (this.promptBlockPresets || []).filter(p => p.id !== item.id);
                this.persistPromptPresets();
            } else {
                this.promptSnippetPresets = (this.promptSnippetPresets || []).filter(s => s.id !== item.id);
                this.persistPromptPresets();
            }
            this.showUiToast('已删除本地资源', 'success');
        },

        exportLocalKind() {
            const kind = this.libraryKind;
            const items = kind === 'template'
                ? (this.userTemplates || [])
                : (kind === 'preset' ? (this.promptBlockPresets || []) : (this.promptSnippetPresets || []));
            const payload = CatalogClient.buildLocalExport(kind, items);
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `本地-${kind}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        },

        triggerLocalImport() {
            if (this.$refs.localImportFile) this.$refs.localImportFile.click();
        },

        handleLocalImportFile(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = e => {
                try {
                    const items = CatalogClient.parseLocalImport(this.libraryKind, e.target.result);
                    if (!items.length) throw new Error('没有可导入的条目');
                    this.importLocalItems(items);
                } catch (err) {
                    this.showUiToast(err.message || '导入失败', 'danger');
                }
                event.target.value = '';
            };
            reader.readAsText(file);
        },

        importLocalItems(items) {
            const kind = this.libraryKind;
            let imported = 0;
            items.forEach(item => {
                if (kind === 'template') {
                    const names = (this.userTemplates || []).map(t => t.name);
                    const name = CatalogClient.uniqueCopyName(item.name, names);
                    if (!item.workflow) return;
                    TemplateManager.add({
                        schemaVersion: 2,
                        name,
                        description: item.description || '',
                        workflow: item.workflow,
                        defaults: item.defaults || {},
                        editor: item.editor || {},
                        preview: CatalogClient.normalizePreview(item.preview)
                    });
                    imported += 1;
                } else if (kind === 'preset') {
                    const names = (this.promptBlockPresets || []).map(p => p.name);
                    this.promptBlockPresets = [{
                        id: CatalogClient.newLocalId('preset'),
                        name: CatalogClient.uniqueCopyName(item.name, names),
                        prompt: item.prompt,
                        negative_prompt: item.negative_prompt,
                        preview: CatalogClient.normalizePreview(item.preview),
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    }, ...(this.promptBlockPresets || [])];
                    imported += 1;
                } else {
                    const names = (this.promptSnippetPresets || []).map(s => s.name);
                    this.promptSnippetPresets = [{
                        id: CatalogClient.newLocalId('snippet'),
                        name: CatalogClient.uniqueCopyName(item.name, names),
                        text: item.text,
                        target: item.target,
                        preview: CatalogClient.normalizePreview(item.preview),
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    }, ...(this.promptSnippetPresets || [])];
                    imported += 1;
                }
            });
            if (kind === 'template') this.loadUserTemplates();
            else this.persistPromptPresets();
            this.showUiToast(`已导入 ${imported} 项（不覆盖现有本地资源）`, 'success');
        },

        // ========== 模板管理 ==========
        loadUserTemplates() {
            this.userTemplates = TemplateManager.loadUserTemplates();
        },

        getTemplateDefaultsForSave() {
            // 模板默认值不保存提示词：提示词由“上次输入状态”/“提示词预设”管理
            const cur = this.placeholderValues || {};
            const next = deepCloneJson(cur);
            delete next.prompt;
            delete next.negative_prompt;
            delete next.input_image;
            return next;
        },

        persistSelectedTemplateId() {
            const KEY = 'runpod_selected_template_id_v1';
            try {
                localStorage.setItem(KEY, String(this.selectedTemplateId || ''));
            } catch (e) {
                // ignore
            }
        },

        restoreSelectedTemplateId() {
            // 不覆盖用户已经手动选择的
            if (this.selectedTemplateId) return;

            const KEY = 'runpod_selected_template_id_v1';
            let id = '';
            try {
                id = localStorage.getItem(KEY) || '';
            } catch (e) {
                id = '';
            }
            if (!id) return;

            // 统一库 ID 不依赖 runtime：重载后 runtime 为空也必须保留，交由 onTemplateSelect 按需加载详情
            if (CatalogClient.isSharedId(id)) {
                this.selectedTemplateId = id;
                return;
            }

            const tpl = TemplateManager.get(id);
            if (tpl) {
                this.selectedTemplateId = id;
                return;
            }

            // 已失效的 id，清理
            try {
                localStorage.removeItem(KEY);
            } catch (e) {
                // ignore
            }
        },

        onTemplateSelect() {
            const id = this.selectedTemplateId;
            // 任何选择（含空/本地/内置/已缓存 shared）都先失效旧请求，避免旧响应回写
            this._templateLoadToken = (this._templateLoadToken || 0) + 1;
            this.templateDetailLoadingId = '';
            if (!id) {
                this._templateLoadToken = (this._templateLoadToken || 0) + 1;
                this.templateDetailLoadingId = '';
                this.selectedTemplate = null;
                this.workflowEditorMeta = WorkflowEditor.normalizeEditor({});
                this.loraDrafts = [];
                return;
            }

            const template = TemplateManager.get(id);
            const source = template ? CatalogClient.sourceOf(template) : (CatalogClient.isSharedId(id) ? 'shared' : 'local');

            if (source !== 'shared') {
                if (template) this.applyTemplateToEditor(template);
                return;
            }

            // 统一库模板：本会话已加载且版本与当前目录一致才直接用，否则按需拉取详情
            if (template && template.workflow && typeof template.workflow === 'object') {
                const meta = (this.catalogItems || []).find(it => it && it.id === id) || null;
                const expected = meta && meta.publishedRevision !== null && meta.publishedRevision !== undefined
                    ? Number(meta.publishedRevision)
                    : null;
                const actual = template.sourceRevision === undefined || template.sourceRevision === null
                    ? null
                    : Number(template.sourceRevision);
                if (expected === null || actual === expected) {
                    this.applyTemplateToEditor(template);
                    return;
                }
            }
            return this.loadSharedTemplateIntoEditor(id);
        },

        applyTemplateToEditor(template) {
            if (!template) return;
            let workflow = template.workflow;
            if (typeof workflow === 'string') {
                try {
                    workflow = JSON.parse(workflow);
                } catch (e) {
                    this.errorMessage = '模板 workflow 解析失败: ' + e.message;
                    return;
                }
            }
            // undefined/null/数组都不是可执行 workflow：不解析、不覆盖当前编辑内容
            if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
                this.errorMessage = '模板 workflow 无效：必须是对象';
                return;
            }
            workflow = WorkflowEditor.deepClone(workflow);
            // 解析/验证全部通过后才写入当前快照
            this.selectedTemplate = template;
            this.workflowEditorMeta = WorkflowEditor.normalizeEditor(template.editor);
            this.isWorkflowEditorDirty = false;
            this.selectedWorkflowNodeId = '';
            this.loraDrafts = WorkflowEditor.readManagedLoras(workflow);
            this.workflowJson = JSON.stringify(workflow, null, 2);
        },

        async loadSharedTemplateIntoEditor(id) {
            let meta = (this.catalogItems || []).find(it => it && it.id === id) || null;
            if (!meta) {
                // 挂载时目录请求可能仍未返回（或离线）：回退本地目录缓存取回 publishedRevision，
                // 使 loadCatalogDetail 能精确命中详情缓存；不因缺少 meta 丢弃已选 shared ID
                const cached = CatalogClient.loadCache(localStorage);
                meta = (cached && Array.isArray(cached.items) ? cached.items : []).find(it => it && it.id === id) || null;
            }
            const expected = meta && meta.publishedRevision !== null && meta.publishedRevision !== undefined
                ? Number(meta.publishedRevision)
                : null;
            const token = (this._templateLoadToken || 0) + 1;
            this._templateLoadToken = token;
            this.templateDetailLoadingId = id;
            try {
                const detail = await this.loadCatalogDetail(id, expected);
                // 快速切换模板：旧响应直接丢弃，不覆盖新选择
                if (this._templateLoadToken !== token || this.selectedTemplateId !== id) return;
                const data = (detail && detail.data) || {};
                if (!data.workflow || typeof data.workflow !== 'object' || Array.isArray(data.workflow)) {
                    throw new Error('统一库模板缺少有效 workflow');
                }
                const tpl = this.buildSharedTemplate(detail);
                TemplateManager.upsertRuntimeTemplate(tpl);
                this.applyTemplateToEditor(tpl);
            } catch (e) {
                if (this._templateLoadToken !== token || this.selectedTemplateId !== id) return;
                const msg = e && e.message ? e.message : '模板载入失败';
                this.catalogError = msg;
                this.showUiToast(msg, 'danger');
                // 失败保留上一份 workflow 与参数草稿：回退到上一个可用模板
                const fallback = this.selectedTemplate && this.selectedTemplate.id ? this.selectedTemplate.id : '';
                if (fallback && fallback !== id) this.selectedTemplateId = fallback;
            } finally {
                if (this._templateLoadToken === token) this.templateDetailLoadingId = '';
            }
        },

        saveAsTemplate() {
            this.newTemplateName = '';
            this.newTemplateDescription = '';
            this.showSaveTemplate = true;
        },

        confirmSaveTemplate() {
            if (!this.newTemplateName.trim()) {
                this.showUiToast('请输入模板名称', 'warning');
                return;
            }

            try {
                const defaults = this.getTemplateDefaultsForSave();
                const id = TemplateManager.add({
                    schemaVersion: 2,
                    name: this.newTemplateName,
                    description: this.newTemplateDescription,
                    workflow: this.workflowObj,
                    defaults,
                    editor: WorkflowEditor.deepClone(this.workflowEditorMeta)
                });

                this.loadUserTemplates();
                this.selectedTemplateId = id;
                this.selectedTemplate = TemplateManager.get(id);
                this.showSaveTemplate = false;
                this.isWorkflowEditorDirty = false;

                this.showUiToast('模板保存成功！', 'success');
            } catch (e) {
                this.showUiToast('保存失败: ' + e.message, 'danger');
            }
        },

        async updateTemplate() {
            if (!this.selectedTemplate || TemplateManager.isReadonly(this.selectedTemplate)) return;

            const ok = await this.askConfirm('确定要更新模板吗？', {
                title: '更新确认',
                type: 'warning'
            });
            if (!ok) return;

            const defaults = this.getTemplateDefaultsForSave();
            TemplateManager.update(this.selectedTemplate.id, {
                workflow: this.workflowObj,
                defaults,
                schemaVersion: 2,
                editor: WorkflowEditor.deepClone(this.workflowEditorMeta)
            });
            this.isWorkflowEditorDirty = false;
            this.showUiToast('模板已更新！', 'success');
        },

        async deleteTemplate() {
            if (!this.selectedTemplate || TemplateManager.isReadonly(this.selectedTemplate)) return;

            const ok = await this.askConfirm('确定要删除此模板吗？', {
                title: '删除确认',
                type: 'danger'
            });
            if (!ok) return;

            TemplateManager.delete(this.selectedTemplate.id);
            this.loadUserTemplates();
            this.selectedTemplateId = '';
            this.selectedTemplate = null;
            this.showUiToast('模板已删除', 'success');
        },

        exportTemplate() {
            if (!this.selectedTemplate) return;

            const json = TemplateManager.exportTemplate(this.selectedTemplate.id);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${this.selectedTemplate.name}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        },

        importTemplateDialog() {
            this.importTemplateJson = '';
            this.importError = '';
            this.importTemplateFileName = '';
            this.showImportTemplate = true;
        },

        handleImportFile(event) {
            const file = event.target.files[0];
            if (!file) return;

            this.importTemplateFileName = file.name;

            const reader = new FileReader();
            reader.onload = (e) => {
                this.importTemplateJson = e.target.result;
                event.target.value = '';
            };
            reader.readAsText(file);
        },

        confirmImportTemplate() {
            if (!this.importTemplateJson.trim()) {
                this.importError = '请输入模板/工作流 JSON';
                return;
            }

            try {
                const imported = TemplateManager.importTemplate(this.importTemplateJson);

                // 若导入的是纯工作流文件，默认用文件名作为模板名
                const fileBaseName = (this.importTemplateFileName || '').replace(/\.json$/i, '');
                if (fileBaseName && (imported.name === '导入的模板' || imported.name === '导入的工作流')) {
                    imported.name = fileBaseName;
                }

                const id = TemplateManager.add(imported);

                this.loadUserTemplates();
                this.selectedTemplateId = id;
                this.showImportTemplate = false;

                this.showUiToast('模板导入成功！', 'success');
            } catch (e) {
                this.importError = e.message;
            }
        },

        // ========== 尺寸预设 ==========
        applySizePreset() {
            if (!this.selectedSizePreset) return;
            if (this.placeholderValues.width === undefined || this.placeholderValues.height === undefined) return;
            this.placeholderValues.width = this.selectedSizePreset.width;
            this.placeholderValues.height = this.selectedSizePreset.height;
        },

        // 步进按钮：按占位符 step 增减，带精度与边界处理
        stepPlaceholder(p, direction) {
            if (!p || !p.name) return;
            const cur = Number(this.placeholderValues[p.name]);
            if (!Number.isFinite(cur)) return;

            const step = Number(p.step) || 1;
            const min = (p.min !== undefined && p.min !== null) ? Number(p.min) : -Infinity;
            const max = (p.max !== undefined && p.max !== null) ? Number(p.max) : Infinity;

            // 浮点精度：按 step 小数位四舍五入，避免 7 + 0.1 = 7.100000000000001
            const stepStr = String(step);
            const decimals = (stepStr.split('.')[1] || '').length;

            let next = cur + direction * step;
            next = Number(next.toFixed(Math.min(decimals, 6)));

            if (next < min) next = min;
            if (next > max) next = max;

            this.placeholderValues[p.name] = next;
        },

        onSizeChange() {
            // 检查是否匹配某个预设
            const match = this.sizePresets.find(p =>
                p.width === this.placeholderValues.width &&
                p.height === this.placeholderValues.height
            );
            this.selectedSizePreset = match || '';
        },

        swapSize() {
            const temp = this.placeholderValues.width;
            this.placeholderValues.width = this.placeholderValues.height;
            this.placeholderValues.height = temp;
            this.onSizeChange();
        },

        resetToDefaults() {
            const cur = this.placeholderValues || {};
            const keepPrompt = cur.prompt;
            const keepNeg = cur.negative_prompt;
            const keepInputName = cur.input_image;

            const defaults = PlaceholderEngine.getDefaults(this.placeholders);
            const next = { ...defaults };

            if (this.selectedTemplate && this.selectedTemplate.defaults) {
                Object.keys(this.selectedTemplate.defaults).forEach(key => {
                    if (key === 'prompt' || key === 'negative_prompt' || key === 'input_image') return;
                    if (Object.prototype.hasOwnProperty.call(next, key)) {
                        next[key] = this.selectedTemplate.defaults[key];
                    }
                });
            }

            if (keepPrompt !== undefined && Object.prototype.hasOwnProperty.call(next, 'prompt')) next.prompt = keepPrompt;
            if (keepNeg !== undefined && Object.prototype.hasOwnProperty.call(next, 'negative_prompt')) next.negative_prompt = keepNeg;
            if (keepInputName !== undefined && Object.prototype.hasOwnProperty.call(next, 'input_image')) next.input_image = keepInputName;

            this.placeholderValues = next;
            this.onSizeChange();
        },

        // ========== 参数面板折叠 ==========
        initParamSectionsOpenState() {
            const KEY = 'runpod_param_sections_v1';
            try {
                const raw = localStorage.getItem(KEY);
                if (raw) {
                    const parsed = this.safeJsonParse(raw, null);
                    if (parsed && typeof parsed === 'object') {
                        const next = { ...this.paramSectionsOpen };
                        Object.keys(next).forEach(k => {
                            if (typeof parsed[k] === 'boolean') next[k] = parsed[k];
                        });
                        this.paramSectionsOpen = next;
                        return;
                    }
                }
            } catch (e) {
                // ignore
            }

            // 没有保存过状态时：桌面保持全展开；移动端默认只展开提示词 + 图片尺寸
            const isMobile = window.matchMedia
                ? window.matchMedia('(max-width: 768px)').matches
                : (window.innerWidth <= 768);

            if (isMobile) {
                this.paramSectionsOpen = {
                    ...this.paramSectionsOpen,
                    size: true,
                    prompt: true,
                    sampling: false,
                    inputImage: false,
                    other: false
                };
            } else {
                this.paramSectionsOpen = {
                    ...this.paramSectionsOpen,
                    size: true,
                    prompt: true,
                    sampling: true,
                    inputImage: true,
                    other: true
                };
            }
        },

        persistParamSectionsOpenState() {
            const KEY = 'runpod_param_sections_v1';
            try {
                localStorage.setItem(KEY, JSON.stringify(this.paramSectionsOpen || {}));
            } catch (e) {
                // ignore
            }
        },

        toggleParamSection(key) {
            if (!key) return;
            const cur = this.paramSectionsOpen || {};
            if (typeof cur[key] !== 'boolean') return;

            this.paramSectionsOpen = {
                ...cur,
                [key]: !cur[key]
            };
            this.persistParamSectionsOpenState();
        },

        // ========== Workflow 编辑 ==========
        saveCursorPosition() {
            const textarea = this.$refs.workflowTextarea;
            if (textarea) {
                this.cursorPosition = textarea.selectionStart;
            }
        },

        insertPlaceholder(placeholder) {
            const textarea = this.$refs.workflowTextarea;
            if (!textarea) return;

            const before = this.workflowJson.substring(0, this.cursorPosition);
            const after = this.workflowJson.substring(this.cursorPosition);
            this.workflowJson = before + placeholder + after;

            this.$nextTick(() => {
                const newPos = this.cursorPosition + placeholder.length;
                textarea.selectionStart = newPos;
                textarea.selectionEnd = newPos;
                textarea.focus();
                this.cursorPosition = newPos;
            });
        },

        togglePreview() {
            this.showPreview = !this.showPreview;
        },

        toggleWorkflowCollapse() {
            this.isWorkflowCollapsed = !this.isWorkflowCollapsed;
            if (this.isWorkflowCollapsed) {
                this.showPreview = false;
            }
        },

        handleWorkflowUpload(event) {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    JSON.parse(e.target.result); // 验证 JSON
                    this.workflowJson = e.target.result;
                    this.selectedTemplateId = '';
                    this.selectedTemplate = null;
                    this.workflowEditorMeta = WorkflowEditor.normalizeEditor({});
                    this.loraDrafts = [];
                    this.isWorkflowEditorDirty = false;
                } catch (err) {
                    this.errorMessage = 'JSON 文件格式错误: ' + err.message;
                }
            };
            reader.readAsText(file);
            event.target.value = '';
        },

        clearWorkflow() {
            this.workflowJson = '';
            this.workflowObj = null;
            this.placeholders = [];
            this.placeholderValues = {};
            this.selectedTemplateId = '';
            this.selectedTemplate = null;
            this.workflowEditorMeta = WorkflowEditor.normalizeEditor({});
            this.loraDrafts = [];
            this.isWorkflowEditorDirty = false;
            this.errorMessage = '';
        },

        // ========== 输入图片 ==========
        addInputImage() {
            this.inputImages.push({
                name: `input_${this.inputImages.length + 1}.png`,
                image: '',
                sizeWarning: ''
            });
        },

        removeInputImage(index) {
            this.inputImages.splice(index, 1);
        },

        // ========== 历史持久化 ==========
        async loadPersistedHistory() {
            if (!window.HistoryStore) return;
            try {
                await window.HistoryStore.init();
                const loaded = await window.HistoryStore.load();
                const records = loaded && Array.isArray(loaded.records) ? loaded.records : [];
                const favorites = loaded && Array.isArray(loaded.favorites) ? loaded.favorites : [];
                const imageMap = loaded && loaded.imageMap ? loaded.imageMap : {};

                // 先恢复收藏（即使没有历史记录）
                this.favorites = (favorites || []).map(f => ({
                    ...f,
                    placeholderValues: f && f.placeholderValues && typeof f.placeholderValues === 'object' ? f.placeholderValues : {}
                }));
                this.favoriteImageCache = {};
                this.favorites.forEach(f => {
                    const stored = imageMap && f && f.id ? imageMap[f.id] : null;
                    if (!stored) return;

                    const type = stored.type || (f.type || 'base64');
                    const data = stored.data || '';
                    const imageUrl = type === 'base64'
                        ? `data:image/png;base64,${data}`
                        : data;

                    this.favoriteImageCache[f.id] = {
                        id: stored.id,
                        filename: stored.filename || (f.filename || 'image.png'),
                        type,
                        data,
                        imageUrl,
                        createdAt: stored.createdAt || (f.addedAt || Date.now())
                    };
                });

                if (!Array.isArray(records) || records.length === 0) {
                    this.requestHistory = [];
                    this.ensureResultsSelection();
                    return;
                }

                const restored = records.map(r => {
                    const images = (r.images || []).map(ref => {
                        const stored = imageMap && ref && ref.id ? imageMap[ref.id] : null;
                        if (!stored) return null;

                        const type = stored.type || (ref.type || 'base64');
                        const data = stored.data || '';
                        const imageUrl = type === 'base64'
                            ? `data:image/png;base64,${data}`
                            : data;

                        return {
                            id: stored.id,
                            filename: stored.filename || (ref.filename || 'image.png'),
                            type,
                            data,
                            imageUrl,
                            createdAt: stored.createdAt || r.createdAt
                        };
                    }).filter(Boolean);

                    return {
                        ...r,
                        deletedImages: Array.isArray(r.deletedImages) ? r.deletedImages : [],
                        images
                    };
                });

                this.requestHistory = restored;
                this.resultsTab = 'history';

                // 为旧收藏回填参数（如果对应请求仍在历史中）
                this.backfillFavoritesFromHistory();
                this.ensureResultsSelection();
            } catch (e) {
                // 持久化不可用时，忽略
            }
        },

        queuePersistHistory() {
            if (!window.HistoryStore) return;
            if (this._persistTimer) clearTimeout(this._persistTimer);
            this._persistTimer = setTimeout(() => {
                this.persistHistoryNow();
            }, 400);
        },

        async persistHistoryNow() {
            if (!window.HistoryStore) return;
            try {
                const records = this.serializeHistoryForStore();
                const favorites = this.serializeFavoritesForStore();
                const pruned = await window.HistoryStore.save({ records, favorites });
                this.applyPrunedRecordsToMemory(pruned.records);
                this.applyPrunedFavoritesToMemory(pruned.favorites);
                this.ensureResultsSelection();
            } catch (e) {
                // 忽略持久化失败
            }
        },

        serializeHistoryForStore() {
            return (this.requestHistory || []).map(r => ({
                id: r.id,
                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
                status: r.status,
                runMode: r.runMode,
                endpointId: r.endpointId,
                jobId: r.jobId,
                templateId: r.templateId,
                templateName: r.templateName,
                workflowJson: r.workflowJson,
                placeholderValues: r.placeholderValues,
                payloadSize: r.payloadSize,
                delayTime: r.delayTime,
                executionTime: r.executionTime,
                errorMessage: r.errorMessage,
                deletedImages: Array.isArray(r.deletedImages) ? r.deletedImages : [],
                images: (r.images || []).map(img => ({
                    id: img.id,
                    filename: img.filename || 'image.png',
                    type: img.type || 'base64'
                }))
            }));
        },

        serializeFavoritesForStore() {
            return (this.favorites || []).map(f => ({
                id: f.id,
                addedAt: f.addedAt,
                filename: f.filename || 'image.png',
                type: f.type || 'base64',
                requestId: f.requestId || '',
                requestCreatedAt: f.requestCreatedAt !== undefined ? f.requestCreatedAt : null,
                requestTemplateId: f.requestTemplateId || '',
                requestTemplateName: f.requestTemplateName || '',
                requestJobId: f.requestJobId || '',
                placeholderValues: f.placeholderValues && typeof f.placeholderValues === 'object' ? f.placeholderValues : {}
            }));
        },

        applyPrunedRecordsToMemory(prunedRecords) {
            if (!Array.isArray(prunedRecords)) return;

            const currentMap = new Map((this.requestHistory || []).map(r => [r.id, r]));
            const next = [];

            prunedRecords.forEach(pr => {
                const curr = currentMap.get(pr.id);
                if (!curr) return;

                const imgMap = new Map((curr.images || []).map(img => [img.id, img]));
                const images = (pr.images || []).map(ref => imgMap.get(ref.id)).filter(Boolean);

                const merged = { ...curr, ...pr };
                merged.images = images;
                next.push(merged);
            });

            this.requestHistory = next;
        },

        applyPrunedFavoritesToMemory(prunedFavorites) {
            if (!Array.isArray(prunedFavorites)) return;
            const next = prunedFavorites.filter(f => f && f.id);
            const keepSet = new Set(next.map(f => f.id));
            const nextCache = {};

            Object.keys(this.favoriteImageCache || {}).forEach(id => {
                if (keepSet.has(id)) {
                    nextCache[id] = this.favoriteImageCache[id];
                }
            });

            this.favorites = next;
            this.favoriteImageCache = nextCache;

            if (this.selectedFavoriteIndex < 0) this.selectedFavoriteIndex = 0;
            if (this.selectedFavoriteIndex >= this.favoriteImages.length) {
                this.selectedFavoriteIndex = Math.max(0, this.favoriteImages.length - 1);
            }
        },

        ensureResultsSelection() {
            if (!Array.isArray(this.requestHistory) || this.requestHistory.length === 0) {
                this.selectedHistoryId = '';
                this.selectedHistoryImageIndex = 0;
                this.selectedGalleryIndex = 0;
                return;
            }

            const hasSelected = this.selectedHistoryId && this.requestHistory.some(r => r.id === this.selectedHistoryId);
            if (!hasSelected) {
                this.selectedHistoryId = this.requestHistory[0].id;
                this.selectedHistoryImageIndex = 0;
            }

            // 修正历史图片索引（避免删除后出现 3/1 之类的显示）
            const rec = this.requestHistory.find(r => r.id === this.selectedHistoryId) || this.requestHistory[0];
            const imgLen = rec && Array.isArray(rec.images) ? rec.images.length : 0;
            if (imgLen <= 0) {
                this.selectedHistoryImageIndex = 0;
            } else {
                if (this.selectedHistoryImageIndex < 0) this.selectedHistoryImageIndex = 0;
                if (this.selectedHistoryImageIndex >= imgLen) this.selectedHistoryImageIndex = imgLen - 1;
            }

            const galleryCount = this.galleryImages.length;
            if (galleryCount === 0) {
                this.selectedGalleryIndex = 0;
                return;
            }
            if (this.selectedGalleryIndex < 0) this.selectedGalleryIndex = 0;
            if (this.selectedGalleryIndex >= galleryCount) this.selectedGalleryIndex = galleryCount - 1;
        },

        // ========== 请求历史 ==========
        createHistoryEntry(meta) {
            const now = Date.now();
            const templateName = this.selectedTemplate ? this.selectedTemplate.name : '';

            return {
                id: generateLocalId('req'),
                createdAt: now,
                updatedAt: now,
                status: 'SUBMITTING',
                runMode: meta.runMode || '',
                endpointId: meta.endpointId || '',
                jobId: '',
                templateId: this.selectedTemplateId || '',
                templateName,
                workflowJson: this.workflowJson,
                placeholderValues: deepCloneJson(this.placeholderValues),
                payloadSize: meta.payloadSize || 0,
                imageCount: meta.imageCount || 0,
                delayTime: null,
                executionTime: null,
                errorMessage: '',
                deletedImages: [],
                images: []
            };
        },

        updateHistoryEntry(entryId, patch) {
            const idx = this.requestHistory.findIndex(r => r.id === entryId);
            if (idx === -1) return;

            this.requestHistory[idx] = {
                ...this.requestHistory[idx],
                ...patch,
                updatedAt: Date.now()
            };

            this.queuePersistHistory();
        },

        extractImagesFromRunpodData(data) {
            const output = data && data.output ? data.output : null;
            if (!output) return [];

            const images = [];

            if (output.images && Array.isArray(output.images)) {
                output.images.forEach(img => {
                    if (img.type === 'base64') {
                        images.push({
                            id: generateLocalId('img'),
                            filename: img.filename || 'image.png',
                            type: 'base64',
                            data: img.data,
                            imageUrl: `data:image/png;base64,${img.data}`,
                            createdAt: Date.now()
                        });
                    } else if (img.type === 's3_url') {
                        images.push({
                            id: generateLocalId('img'),
                            filename: img.filename || 'image.png',
                            type: 's3_url',
                            data: img.data,
                            imageUrl: img.data,
                            createdAt: Date.now()
                        });
                    }
                });
            } else if (output.message && typeof output.message === 'string' && output.message.includes('data:image')) {
                images.push({
                    id: generateLocalId('img'),
                    filename: 'image.png',
                    type: 'base64',
                    data: output.message.split(',')[1],
                    imageUrl: output.message,
                    createdAt: Date.now()
                });
            }

            return images;
        },

        async finalizeHistoryEntry(entryId, data) {
            const images = this.extractImagesFromRunpodData(data);

            if (images.length === 0) {
                const msg = '未在返回结果中找到图片';
                this.errorMessage = msg;
                this.updateHistoryEntry(entryId, {
                    status: 'FAILED',
                    errorMessage: msg,
                    executionTime: data && data.executionTime !== undefined ? data.executionTime : null
                });
                return;
            }

            // 持久化图片数据（IndexedDB）
            if (window.HistoryStore && window.HistoryStore.isIndexedDbAvailable()) {
                try {
                    await window.HistoryStore.putImages(images);
                } catch (e) {
                    // ignore
                }
            }

            this.updateHistoryEntry(entryId, {
                status: 'COMPLETED',
                images,
                executionTime: data && data.executionTime !== undefined ? data.executionTime : null
            });

            // 如果用户当前正在查看该请求，则自动切到第一张
            if (this.selectedHistoryId === entryId || !this.selectedHistoryId) {
                this.selectedHistoryId = entryId;
                this.selectedHistoryImageIndex = 0;
                this.selectedGalleryIndex = 0;
            }

            // 完成后立即持久化（含裁剪）
            await this.persistHistoryNow();
        },

        // ========== 生成（并发 / 排队） ==========
        clampInt(value, min, max) {
            const n = Math.trunc(Number(value));
            if (!Number.isFinite(n)) return min;
            return Math.min(max, Math.max(min, n));
        },

        toSafeInt(value, fallback) {
            const n = Math.trunc(Number(value));
            return Number.isFinite(n) ? n : fallback;
        },

        getEffectivePollIntervalMs() {
            const base = (this.settings && typeof this.settings === 'object') ? this.settings : Settings.get();
            const raw = base && base.pollIntervalMs !== undefined ? base.pollIntervalMs : 2000;
            const n = Math.trunc(Number(raw));
            if (!Number.isFinite(n)) return 2000;
            return this.clampInt(n, 1000, 10000);
        },

        getEffectiveInitialPollDelayMs() {
            const base = (this.settings && typeof this.settings === 'object') ? this.settings : Settings.get();
            if (!base || !base.initialPollDelayEnabled) return 0;
            const raw = base.initialPollDelayMs !== undefined ? base.initialPollDelayMs : 3000;
            const n = Math.trunc(Number(raw));
            if (!Number.isFinite(n)) return 3000;
            return this.clampInt(n, 0, 60000);
        },

        getEffectiveRunMode() {
            const base = (this.settings && typeof this.settings === 'object') ? this.settings : Settings.get();
            return base && base.runMode === 'runsync' ? 'runsync' : 'run';
        },

        getEffectiveAutoScrollToResults() {
            const base = (this.settings && typeof this.settings === 'object') ? this.settings : Settings.get();
            // 默认开启：仅在设置中显式关闭时不滚动
            return !(base && base.autoScrollToResults === false);
        },

        getClientConfigSnapshot() {
            const base = (this.settings && typeof this.settings === 'object') ? this.settings : Settings.get();
            return {
                endpointId: (base && base.endpointId) || '',
                apiKey: (base && base.apiKey) || '',
                baseUrl: (RunpodClient && RunpodClient.config && RunpodClient.config.baseUrl) || 'https://api.runpod.ai/v2'
            };
        },

        buildClientConfigForHistoryRecord(record) {
            const cfg = this.getClientConfigSnapshot();
            if (!record || !record.endpointId) return cfg;
            return {
                ...cfg,
                endpointId: String(record.endpointId)
            };
        },

        isManualRetryableStatus(status) {
            return status === 'IN_PROGRESS' || status === 'IN_QUEUE' || status === 'SUBMITTING';
        },

        getManualRetryState(record) {
            if (!record || !record.id) {
                return { ok: false, reason: '请求记录不存在' };
            }

            if (!this.isConfigured) {
                return { ok: false, reason: '请先配置 Endpoint 与 API Key' };
            }

            if (!this.isManualRetryableStatus(record.status)) {
                return { ok: false, reason: '仅处理中请求支持手动重试轮询' };
            }

            if (!record.jobId) {
                return { ok: false, reason: '该请求尚无 Job ID，暂时无法重试' };
            }

            const historyId = record.id;
            const active = (this.activeJobs || []).some(t => t && t.historyId === historyId);
            if (active) {
                return { ok: false, reason: '该请求已在重试中' };
            }

            const queued = (this.jobQueue || []).some(t => t && t.historyId === historyId);
            if (queued) {
                return { ok: false, reason: '该请求已在队列中' };
            }

            return { ok: true, reason: '' };
        },

        getManualRetryTitle(record) {
            const state = this.getManualRetryState(record);
            return state.ok ? '点击重试轮询' : state.reason;
        },

        canManualRetryRecord(record) {
            return this.getManualRetryState(record).ok;
        },

        onHistoryStatusClick(record) {
            if (!record || !record.id) return;
            const state = this.getManualRetryState(record);
            if (!state.ok) {
                this.showUiToast(state.reason, 'info');
                return;
            }
            this.retryHistoryRecord(record.id);
        },

        retryHistoryRecord(historyId) {
            const record = (this.requestHistory || []).find(r => r && r.id === historyId);
            if (!record) return;

            const state = this.getManualRetryState(record);
            if (!state.ok) {
                this.showUiToast(state.reason, 'info');
                return;
            }

            const jobId = String(record.jobId || '');

            const task = {
                taskId: generateLocalId('retry'),
                historyId,
                runMode: 'run',
                initialPollDelayMs: 0,
                pollIntervalMs: this.getEffectivePollIntervalMs(),
                clientConfig: this.buildClientConfigForHistoryRecord(record),
                payload: null,
                cancelRequested: false,
                jobId,
                pollOnly: true
            };

            this.errorMessage = '';
            this.updateHistoryEntry(historyId, { status: 'IN_PROGRESS', errorMessage: '' });
            this.startTask(task);
            this.showUiToast('已开始重试轮询', 'info');
        },

        getEffectiveGenerationSettings() {
            const base = (this.settings && typeof this.settings === 'object') ? this.settings : Settings.get();
            const storeMaxRaw = window.HistoryStore && window.HistoryStore.LIMITS ? window.HistoryStore.LIMITS.maxRequests : 30;
            const storeMax = Number.isFinite(Number(storeMaxRaw)) ? Number(storeMaxRaw) : 30;

            const allowQueue = !!(base && base.allowQueue);
            const allowConcurrent = !!(base && base.allowConcurrent);

            let maxConcurrent = allowConcurrent ? this.toSafeInt(base.maxConcurrent, 1) : 1;
            maxConcurrent = this.clampInt(maxConcurrent, 1, Math.max(1, storeMax));

            let maxQueue = allowQueue ? this.toSafeInt(base.maxQueue, 0) : 0;
            // 约束：并发 + 排队不超过历史记录上限，避免任务记录被裁剪导致状态丢失
            maxQueue = this.clampInt(maxQueue, 0, Math.max(0, storeMax - maxConcurrent));

            // 允许排队时，锁参数必定关闭
            const lockParamsOnGenerate = !!(base && base.lockParamsOnGenerate) && !allowQueue;

            return {
                lockParamsOnGenerate,
                allowConcurrent,
                allowQueue,
                maxConcurrent,
                maxQueue,
                storeMax
            };
        },

        getNewTaskAcceptance() {
            const s = this.getEffectiveGenerationSettings();
            const active = Array.isArray(this.activeJobs) ? this.activeJobs.length : 0;
            const queued = Array.isArray(this.jobQueue) ? this.jobQueue.length : 0;

            if (active < s.maxConcurrent) return { mode: 'start', message: '' };
            if (s.allowQueue && queued < s.maxQueue) return { mode: 'queue', message: '' };

            if (s.allowQueue) {
                return { mode: 'reject', message: `排队已满（上限 ${s.maxQueue}）` };
            }
            return { mode: 'reject', message: `并发已满（上限 ${s.maxConcurrent}）` };
        },

        buildPayloadForCurrentInput() {
            const finalWorkflow = this.finalWorkflow;
            if (!finalWorkflow) {
                return { success: false, message: 'Workflow 无效或未解析完成' };
            }

            const payload = {
                input: {
                    workflow: deepCloneJson(finalWorkflow)
                }
            };

            // 添加输入图片
            const validImages = [];

            // 1. 处理占位符形式的输入图片
            if (this.hasInputImagePlaceholder && this.inputImageData) {
                const imageName = (this.placeholderValues && this.placeholderValues.input_image) || 'input.png';
                validImages.push({
                    name: imageName,
                    image: this.inputImageData
                });
            }

            // 2. 处理列表形式的输入图片（向后兼容）
            (this.inputImages || [])
                .filter(img => img && img.image && img.name)
                .forEach(img => {
                    validImages.push({
                        name: img.name,
                        image: img.image
                    });
                });

            if (validImages.length > 0) {
                payload.input.images = deepCloneJson(validImages);
            }

            // 估算请求大小
            const payloadSize = JSON.stringify(payload).length;
            if (payloadSize > 10 * 1024 * 1024) {
                return {
                    success: false,
                    payloadSize,
                    imageCount: validImages.length,
                    message: `请求体过大 (${formatFileSize(payloadSize)})，超过 10MB 限制。请减少输入图片数量或大小。`
                };
            }

            return {
                success: true,
                payload,
                payloadSize,
                imageCount: validImages.length
            };
        },

        removeActiveTask(taskId) {
            this.activeJobs = (this.activeJobs || []).filter(j => j && j.taskId !== taskId);
        },

        startTask(task) {
            if (!task || !task.taskId || !task.historyId) return;

            const exists = (this.activeJobs || []).some(j => j && j.historyId === task.historyId);
            if (exists) return;

            if (task.cancelRequested) {
                this.updateHistoryEntry(task.historyId, { status: 'CANCELLED', errorMessage: '用户取消' });
                return;
            }

            this.activeJobs.push(task);
            if (!task.pollOnly) {
                this.updateHistoryEntry(task.historyId, { status: 'SUBMITTING', errorMessage: '' });
            }

            this.runTask(task)
                .catch(() => {
                    // ignore (runTask 会自行落库)
                })
                .finally(() => {
                    this.removeActiveTask(task.taskId);
                    this.pumpQueue();
                });
        },

        pumpQueue() {
            const s = this.getEffectiveGenerationSettings();
            const active = Array.isArray(this.activeJobs) ? this.activeJobs.length : 0;
            if (active >= s.maxConcurrent) return;

            while ((this.activeJobs || []).length < s.maxConcurrent && (this.jobQueue || []).length > 0) {
                const task = this.jobQueue.shift();
                if (!task || task.cancelRequested) continue;
                this.startTask(task);
            }
        },

        async runTask(task) {
            const historyId = task && task.historyId ? task.historyId : '';
            const clientCfg = task && task.clientConfig ? task.clientConfig : this.getClientConfigSnapshot();
            const pollOnly = !!(task && task.pollOnly);
            const payload = task && task.payload ? task.payload : null;

            if (!historyId) {
                return;
            }

            if (!pollOnly && !payload) {
                return;
            }

            if (task.cancelRequested) {
                this.updateHistoryEntry(historyId, { status: 'CANCELLED', errorMessage: '用户取消' });
                return;
            }

            try {
                if (pollOnly) {
                    await this.pollExistingJob(task, historyId, task.jobId, clientCfg);
                    return;
                }

                if (task.runMode === 'runsync') {
                    this.updateHistoryEntry(historyId, { status: 'IN_PROGRESS' });
                    const result = await RunpodClient.runSync(payload, 300000, clientCfg);

                    if (task.cancelRequested) {
                        this.updateHistoryEntry(historyId, { status: 'CANCELLED', errorMessage: '用户取消' });
                        return;
                    }

                    if (result.success) {
                        await this.finalizeHistoryEntry(historyId, result.data);
                    } else {
                        this.errorMessage = result.message;
                        this.updateHistoryEntry(historyId, { status: 'FAILED', errorMessage: result.message });
                    }
                    return;
                }

                const runResult = await RunpodClient.run(payload, clientCfg);
                if (!runResult.success) {
                    this.errorMessage = runResult.message;
                    this.updateHistoryEntry(historyId, { status: 'FAILED', errorMessage: runResult.message });
                    return;
                }

                const jobId = runResult.data && runResult.data.id ? String(runResult.data.id) : '';
                const initStatus = runResult.data && runResult.data.status ? String(runResult.data.status) : 'IN_QUEUE';
                task.jobId = jobId;

                if (task.cancelRequested) {
                    if (jobId) {
                        try {
                            await RunpodClient.cancel(jobId, clientCfg);
                        } catch (e) {
                            // ignore
                        }
                    }
                    this.updateHistoryEntry(historyId, { jobId, status: 'CANCELLED', errorMessage: '用户取消' });
                    return;
                }

                this.updateHistoryEntry(historyId, { jobId, status: initStatus });

                if (!jobId) {
                    this.errorMessage = '提交任务失败：未返回 job id';
                    this.updateHistoryEntry(historyId, { status: 'FAILED', errorMessage: '提交任务失败：未返回 job id' });
                    return;
                }

                if (['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(initStatus)) {
                    if (initStatus === 'COMPLETED') {
                        await this.finalizeHistoryEntry(historyId, runResult.data);
                    } else {
                        const message = initStatus === 'FAILED'
                            ? '任务失败'
                            : initStatus === 'TIMED_OUT'
                                ? '任务超时'
                                : '任务已取消';
                        this.errorMessage = message;
                        this.updateHistoryEntry(historyId, { status: initStatus, errorMessage: message });
                    }
                    return;
                }

                await this.pollExistingJob(task, historyId, jobId, clientCfg);
            } catch (err) {
                const msg = '生成失败: ' + (err && err.message ? err.message : String(err));
                this.errorMessage = msg;
                this.updateHistoryEntry(historyId, { status: 'FAILED', errorMessage: msg });
            }
        },

        async pollExistingJob(task, historyId, jobId, clientCfg) {
            const id = jobId ? String(jobId) : '';
            if (!id) {
                this.errorMessage = '轮询失败：缺少 job id';
                this.updateHistoryEntry(historyId, { status: 'FAILED', errorMessage: '轮询失败：缺少 job id' });
                return;
            }

            const pollResult = await RunpodClient.poll(id, {
                initialDelayMs: task.pollOnly ? 0 : task.initialPollDelayMs,
                intervalMs: task.pollIntervalMs,
                onStatus: (data) => {
                    if (task.cancelRequested) return;
                    this.updateHistoryEntry(historyId, {
                        status: data.status,
                        delayTime: data.delayTime !== undefined ? data.delayTime : null
                    });
                },
                shouldStop: () => task.cancelRequested
            }, clientCfg);

            if (pollResult.success) {
                await this.finalizeHistoryEntry(historyId, pollResult.data);
            } else if (pollResult.cancelled) {
                this.updateHistoryEntry(historyId, { status: 'CANCELLED', errorMessage: '用户取消' });
            } else {
                const st = pollResult.status || 'FAILED';
                this.errorMessage = pollResult.message;
                this.updateHistoryEntry(historyId, { status: st, errorMessage: pollResult.message });
            }
        },

        async generate() {
            if (!this.canGenerate) return;

            const accept = this.getNewTaskAcceptance();
            if (accept.mode === 'reject') {
                this.errorMessage = accept.message;
                return;
            }

            this.errorMessage = '';

            // 每次生成前随机 seed
            if (this.seedRandomEachRun && this.hasSeedPlaceholder) {
                this.randomizeSeedOnce();
            }

            const build = this.buildPayloadForCurrentInput();
            if (!build.success) {
                this.errorMessage = build.message;
                return;
            }

            const runMode = this.getEffectiveRunMode();
            const initialPollDelayMs = runMode === 'run'
                ? this.getEffectiveInitialPollDelayMs()
                : 0;
            const pollIntervalMs = this.getEffectivePollIntervalMs();
            const clientConfig = this.getClientConfigSnapshot();

            // 创建请求历史记录
            const historyEntry = this.createHistoryEntry({
                runMode,
                endpointId: clientConfig.endpointId,
                payloadSize: build.payloadSize,
                imageCount: build.imageCount
            });
            this.requestHistory.unshift(historyEntry);
            this.selectedHistoryId = historyEntry.id;
            this.selectedHistoryImageIndex = 0;
            this.resultsTab = 'history';
            this.queuePersistHistory();

            const task = {
                taskId: generateLocalId('task'),
                historyId: historyEntry.id,
                runMode,
                initialPollDelayMs,
                pollIntervalMs,
                clientConfig,
                payload: build.payload,
                cancelRequested: false,
                jobId: ''
            };

            if (accept.mode === 'start') {
                this.startTask(task);
            } else {
                this.jobQueue.push(task);
                this.updateHistoryEntry(historyEntry.id, { status: 'IN_QUEUE' });
            }

            // 若此时并发有空位，立即尝试启动队列
            this.pumpQueue();

            // 生成后滚动到结果区（可在设置 → 生成行为中关闭）
            if (this.getEffectiveAutoScrollToResults()) {
                this.$nextTick(() => this.scrollToResults());
            }
        },

        scrollToResults() {
            this.mobileResultsOpen = true;
            const el = document.getElementById('results-section');
            if (el && el.scrollIntoView) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        },

        cancelTaskByHistoryId(historyId) {
            if (!historyId) return false;

            // 1) 先取消本地队列
            const qIdx = (this.jobQueue || []).findIndex(t => t && t.historyId === historyId);
            if (qIdx !== -1) {
                const task = this.jobQueue[qIdx];
                if (task) task.cancelRequested = true;
                this.jobQueue.splice(qIdx, 1);
                this.updateHistoryEntry(historyId, { status: 'CANCELLED', errorMessage: '用户取消' });
                return true;
            }

            // 2) 取消正在运行的任务
            const task = (this.activeJobs || []).find(t => t && t.historyId === historyId);
            if (!task) return false;

            task.cancelRequested = true;
            this.updateHistoryEntry(historyId, { status: 'CANCELLED', errorMessage: '用户取消' });

            if (task.runMode === 'run' && task.jobId) {
                RunpodClient.cancel(task.jobId, task.clientConfig).catch(() => {
                    // ignore
                });
            }
            return true;
        },

        // 取消选中任务（A）
        cancelGeneration() {
            const rec = this.selectedHistoryRecord;
            if (!rec || !rec.id) return;
            this.cancelTaskByHistoryId(rec.id);
        },

        // 取消全部（运行中 + 排队）
        cancelAllGenerations() {
            // 取消队列
            (this.jobQueue || []).forEach(t => {
                if (!t || !t.historyId) return;
                t.cancelRequested = true;
                this.updateHistoryEntry(t.historyId, { status: 'CANCELLED', errorMessage: '用户取消' });
            });
            this.jobQueue = [];

            // 取消运行中
            (this.activeJobs || []).forEach(t => {
                if (!t || !t.historyId) return;
                t.cancelRequested = true;
                this.updateHistoryEntry(t.historyId, { status: 'CANCELLED', errorMessage: '用户取消' });
                if (t.runMode === 'run' && t.jobId) {
                    RunpodClient.cancel(t.jobId, t.clientConfig).catch(() => {
                        // ignore
                    });
                }
            });
        },

        // ========== 设置 ==========
        openSettings() {
            // 每次打开都从“已生效设置”复制一份，避免未保存的修改影响运行时逻辑
            const base = (this.settings && typeof this.settings === 'object') ? this.settings : Settings.get();
            this.settingsForm = { ...base };
            this.connectionTestResult = null;
            this.showApiKey = false;
            this.showSettings = true;

            // 触发基础约束
            if (this.settingsForm.allowQueue) {
                this.settingsForm.lockParamsOnGenerate = false;
            }
            if (!this.settingsForm.allowConcurrent) {
                this.settingsForm.maxConcurrent = 1;
            }
        },

        closeSettings() {
            this.showSettings = false;
            this.connectionTestResult = null;

            // 丢弃未保存的表单修改
            const base = (this.settings && typeof this.settings === 'object') ? this.settings : Settings.get();
            this.settingsForm = { ...base };
        },

        saveSettings() {
            const storeMaxRaw = window.HistoryStore && window.HistoryStore.LIMITS ? window.HistoryStore.LIMITS.maxRequests : 30;
            const storeMax = Number.isFinite(Number(storeMaxRaw)) ? Number(storeMaxRaw) : 30;

            const allowQueue = !!this.settingsForm.allowQueue;
            const allowConcurrent = !!this.settingsForm.allowConcurrent;

            // 允许排队时，锁参数必定关闭
            const lockParamsOnGenerate = allowQueue ? false : !!this.settingsForm.lockParamsOnGenerate;

            let maxConcurrent = allowConcurrent ? this.toSafeInt(this.settingsForm.maxConcurrent, 1) : 1;
            maxConcurrent = this.clampInt(maxConcurrent, 1, Math.max(1, storeMax));

            let maxQueue = allowQueue ? this.toSafeInt(this.settingsForm.maxQueue, 0) : 0;
            maxQueue = this.clampInt(maxQueue, 0, Math.max(0, storeMax - maxConcurrent));

            const pollIntervalMs = this.clampInt(this.toSafeInt(this.settingsForm.pollIntervalMs, 2000), 1000, 10000);
            const initialPollDelayEnabled = !!this.settingsForm.initialPollDelayEnabled;
            const initialPollDelayMs = this.clampInt(
                this.toSafeInt(this.settingsForm.initialPollDelayMs, 3000),
                0,
                60000
            );
            const runMode = this.settingsForm.runMode === 'runsync' ? 'runsync' : 'run';

            const endpointId = Settings.extractEndpointId(this.settingsForm.endpointId);

            Settings.save({
                endpointId,
                apiKey: this.settingsForm.apiKey,
                rememberApiKey: this.settingsForm.rememberApiKey,
                runMode,
                initialPollDelayEnabled,
                initialPollDelayMs,
                pollIntervalMs,

                lockParamsOnGenerate,
                allowConcurrent,
                allowQueue,
                maxConcurrent,
                maxQueue,
                autoScrollToResults: !!this.settingsForm.autoScrollToResults
            });

            RunpodClient.setConfig({
                endpointId,
                apiKey: this.settingsForm.apiKey
            });

            // 更新“已生效设置”
            this.settings = Settings.get();

            this.isConfigValid = Settings.isConfigured();
            this.updateConnectionStatus();
            this.closeSettings();

            // 如果提高了并发上限，可能可以立即启动队列
            this.pumpQueue();
        },

        extractEndpointId() {
            this.settingsForm.endpointId = Settings.extractEndpointId(this.settingsForm.endpointId);
        },

        async testConnection() {
            if (!this.canTestConnection) return;

            this.testingConnection = true;
            this.connectionTestResult = null;

            RunpodClient.setConfig({
                endpointId: this.settingsForm.endpointId,
                apiKey: this.settingsForm.apiKey
            });

            const result = await RunpodClient.health();
            this.connectionTestResult = result;
            this.testingConnection = false;
        },

        updateConnectionStatus() {
            this.connectionStatus = this.isConfigured ? '已配置' : '未配置';
        },

        // ========== 结果视图 ==========
        formatDateTime(ts) {
            if (!ts) return '-';
            try {
                return new Date(ts).toLocaleString();
            } catch (e) {
                return String(ts);
            }
        },

        formatDateTimeShort(ts) {
            if (!ts) return '-';
            try {
                const d = new Date(ts);
                const now = new Date();
                const pad2 = (n) => String(n).padStart(2, '0');
                const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
                const sameDay = d.toDateString() === now.toDateString();
                if (sameDay) return hm;
                const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
                return `${md} ${hm}`;
            } catch (e) {
                return this.formatDateTime(ts);
            }
        },

        formatBytes(bytes) {
            if (bytes === undefined || bytes === null) return '-';
            const num = Number(bytes);
            if (Number.isNaN(num)) return '-';
            return formatFileSize(num);
        },

        getStatusBadgeClass(status) {
            if (status === 'COMPLETED') return 'bg-success';
            if (status === 'FAILED' || status === 'TIMED_OUT') return 'bg-danger';
            if (status === 'CANCELLED') return 'bg-warning text-dark';
            if (status === 'IN_PROGRESS') return 'bg-info';
            if (status === 'IN_QUEUE') return 'bg-secondary';
            return 'bg-secondary';
        },

        selectHistoryRecord(id) {
            this.resultsTab = 'history';
            this.selectedHistoryId = id;
            this.selectedHistoryImageIndex = 0;
        },

        setHistoryImageIndex(index) {
            const images = this.selectedHistoryImages;
            if (!images || images.length === 0) return;
            const idx = Math.max(0, Math.min(index, images.length - 1));
            this.selectedHistoryImageIndex = idx;
        },

        historyPrevImage() {
            if (this.selectedHistoryImageIndex <= 0) return;
            this.selectedHistoryImageIndex -= 1;
        },

        historyNextImage() {
            const images = this.selectedHistoryImages;
            if (!images || images.length === 0) return;
            if (this.selectedHistoryImageIndex >= images.length - 1) return;
            this.selectedHistoryImageIndex += 1;
        },

        selectGalleryImage(index) {
            this.resultsTab = 'gallery';
            this.selectedGalleryIndex = index;
        },

        // ========== 收藏 ==========
        openFavoritesPanel() {
            this.showFavoritesPanel = true;
        },

        closeFavoritesPanel() {
            this.showFavoritesPanel = false;
        },

        toggleFavoritesPanel() {
            this.showFavoritesPanel = !this.showFavoritesPanel;
        },

        backfillFavoritesFromHistory() {
            if (!Array.isArray(this.favorites) || this.favorites.length === 0) return;
            if (!Array.isArray(this.requestHistory) || this.requestHistory.length === 0) return;

            const recordMap = new Map((this.requestHistory || []).map(r => [r.id, r]));
            let changed = false;

            (this.favorites || []).forEach(f => {
                if (!f || !f.id) return;

                const hasValues = f.placeholderValues && typeof f.placeholderValues === 'object' && Object.keys(f.placeholderValues).length > 0;
                if (hasValues) return;
                if (!f.requestId) return;

                const r = recordMap.get(f.requestId);
                if (!r || !r.placeholderValues || typeof r.placeholderValues !== 'object') return;

                f.placeholderValues = deepCloneJson(r.placeholderValues);

                if (!f.requestTemplateName && r.templateName) f.requestTemplateName = r.templateName || '';
                if (!f.requestTemplateId && r.templateId) f.requestTemplateId = r.templateId || '';
                if (!f.requestCreatedAt && r.createdAt) f.requestCreatedAt = r.createdAt;
                if (!f.requestJobId && r.jobId) f.requestJobId = r.jobId || '';

                changed = true;
            });

            if (changed) {
                this.queuePersistHistory();
            }
        },

        isFavorited(imageId) {
            if (!imageId) return false;
            return Array.isArray(this.favorites) && this.favorites.some(f => f && f.id === imageId);
        },

        removeFavoriteById(imageId) {
            if (!imageId) return;
            const idx = (this.favorites || []).findIndex(f => f && f.id === imageId);
            if (idx !== -1) {
                this.favorites.splice(idx, 1);
            }
            if (this.favoriteImageCache && this.favoriteImageCache[imageId]) {
                delete this.favoriteImageCache[imageId];
            }
        },

        findRecordForImage(image) {
            if (!image || !image.id) return null;
            if (image.requestId) {
                return this.requestHistory.find(r => r.id === image.requestId) || null;
            }
            return this.requestHistory.find(r => (r.images || []).some(img => img && img.id === image.id)) || null;
        },

        toggleFavorite(image) {
            if (!image || !image.id) return;

            const id = image.id;
            const existingIdx = (this.favorites || []).findIndex(f => f && f.id === id);

            // 取消收藏
            if (existingIdx !== -1) {
                this.favorites.splice(existingIdx, 1);
                if (this.favoriteImageCache && this.favoriteImageCache[id]) {
                    delete this.favoriteImageCache[id];
                }

                // 如果该图片不在本地历史中，取消收藏后可以清理 IndexedDB
                const stillInHistory = (this.requestHistory || []).some(r =>
                    (r.images || []).some(img => img && img.id === id)
                );
                if (!stillInHistory && window.HistoryStore && window.HistoryStore.deleteImages) {
                    window.HistoryStore.deleteImages([id]).catch(() => { });
                }

                this.syncPreviewAfterDataChange();
                this.persistHistoryNow();
                return;
            }

            // 新增收藏（上限 50，阻止并提示）
            const maxFav = window.HistoryStore && window.HistoryStore.LIMITS
                ? (window.HistoryStore.LIMITS.maxFavorites || 50)
                : 50;
            if ((this.favorites || []).length >= maxFav) {
                this.showUiToast(`收藏已满（最多 ${maxFav} 张）。请先取消收藏或删除一些图片。`, 'warning', 2600);
                return;
            }

            const record = this.findRecordForImage(image);
            const now = Date.now();
            const valuesSource = record && record.placeholderValues && typeof record.placeholderValues === 'object'
                ? record.placeholderValues
                : (image && image.favoritePlaceholderValues && typeof image.favoritePlaceholderValues === 'object'
                    ? image.favoritePlaceholderValues
                    : {});
            const fav = {
                id,
                addedAt: now,
                filename: image.filename || 'image.png',
                type: image.type || 'base64',
                requestId: record ? record.id : (image.requestId || ''),
                requestCreatedAt: record ? record.createdAt : (image.requestCreatedAt !== undefined ? image.requestCreatedAt : null),
                requestTemplateId: record ? (record.templateId || '') : (image.requestTemplateId || ''),
                requestTemplateName: record ? (record.templateName || '') : (image.requestTemplateName || ''),
                requestJobId: record ? (record.jobId || '') : (image.requestJobId || ''),
                placeholderValues: deepCloneJson(valuesSource)
            };

            // 去重兜底（理论不会走到）
            this.favorites = (this.favorites || []).filter(f => f && f.id !== id);
            this.favorites.unshift(fav);

            // 缓存图片，确保请求记录被裁剪后仍能展示收藏
            this.favoriteImageCache = this.favoriteImageCache || {};
            this.favoriteImageCache[id] = {
                id: image.id,
                filename: image.filename || 'image.png',
                type: image.type || 'base64',
                data: image.data || '',
                imageUrl: image.imageUrl || '',
                createdAt: image.createdAt || now
            };

            // 确保收藏图片写入 IndexedDB（避免后续裁剪丢失）
            if (window.HistoryStore && window.HistoryStore.isIndexedDbAvailable && window.HistoryStore.isIndexedDbAvailable()) {
                window.HistoryStore.putImages([image]).catch(() => { });
            }

            this.persistHistoryNow();
        },

        async deleteImage(image, options) {
            if (!image || !image.id) return;

            const filename = image.filename || 'image.png';
            const ok = await this.askConfirm(`确定要删除这张图片吗？\n${filename}\n\n删除后将无法恢复。`, {
                title: '删除图片',
                type: 'danger',
                confirmText: '删除',
                cancelText: '取消'
            });
            if (!ok) return;

            const id = image.id;

            // 从收藏移除
            this.removeFavoriteById(id);

            // 从请求记录中移除
            let record = null;
            if (options && options.recordId) {
                record = this.requestHistory.find(r => r.id === options.recordId) || null;
            }
            if (!record && image.requestId) {
                record = this.requestHistory.find(r => r.id === image.requestId) || null;
            }
            if (!record) {
                record = this.findRecordForImage(image);
            }

            if (record) {
                const nextImages = (record.images || []).filter(img => img && img.id !== id);
                const deleted = {
                    id,
                    filename,
                    deletedAt: Date.now()
                };
                const nextDeleted = Array.isArray(record.deletedImages) ? [...record.deletedImages] : [];
                nextDeleted.unshift(deleted);

                if (nextImages.length === 0) {
                    // 如果该请求只剩这一张图，直接删除整条记录
                    this.requestHistory = (this.requestHistory || []).filter(r => r.id !== record.id);
                } else {
                    record.images = nextImages;
                    record.deletedImages = nextDeleted;
                    record.updatedAt = Date.now();
                }
            }

            // 删除 IndexedDB 中的图片数据
            if (window.HistoryStore && window.HistoryStore.deleteImages) {
                try {
                    await window.HistoryStore.deleteImages([id]);
                } catch (e) {
                    // ignore
                }
            }

            this.ensureResultsSelection();
            this.syncPreviewAfterDataChange();

            await this.persistHistoryNow();
        },

        syncPreviewAfterDataChange() {
            if (!this.showImageModal) return;
            const total = this.previewImages.length;
            if (!total) {
                this.closeImageModal();
                return;
            }
            if (this.previewIndex < 0) this.previewIndex = 0;
            if (this.previewIndex >= total) this.previewIndex = total - 1;
            this.syncSelectionFromPreview();
        },

        // ========== 参数回填 ==========
        async applyParamsFromRecord(record) {
            if (!record) return;

            const hasChanges = this.workflowJson.trim();
            if (hasChanges) {
                const ok = await this.askConfirm('这会覆盖当前的模板/参数设置，是否继续？', {
                    title: '应用参数',
                    type: 'warning'
                });
                if (!ok) return;
            }

            const applyValues = () => {
                this.placeholderValues = deepCloneJson(record.placeholderValues || {});
                this.validatePlaceholders();
                this.onSizeChange();

                const el = document.getElementById('params-panel');
                if (el && el.scrollIntoView) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            };

            const templateExists = record.templateId && TemplateManager.get(record.templateId);
            if (templateExists) {
                this.selectedTemplateId = record.templateId;
                this.$nextTick(() => this.$nextTick(applyValues));
                return;
            }

            // 自定义 workflow
            this.selectedTemplateId = '';
            this.selectedTemplate = null;
            if (record.workflowJson) {
                this.workflowJson = record.workflowJson;
                this.$nextTick(() => this.$nextTick(applyValues));
            } else {
                applyValues();
            }
        },

        async applyParamsFromPreview() {
            const img = this.previewImage;
            if (!img) return;

            // 1) 历史模式：直接用历史记录
            if (this.previewMode === 'history') {
                const rec = this.requestHistory.find(r => r.id === this.previewHistoryId);
                if (rec) {
                    await this.applyParamsFromRecord(rec);
                    return;
                }
            }

            // 2) 图库模式：按 requestId 找记录
            if (this.previewMode === 'gallery') {
                const requestId = img.requestId;
                const rec = requestId ? this.requestHistory.find(r => r.id === requestId) : null;
                if (rec) {
                    await this.applyParamsFromRecord(rec);
                    return;
                }
            }

            // 3) 收藏模式：优先用收藏里保存的参数 + 模板信息
            if (this.previewMode === 'favorites') {
                const fav = (this.favorites || []).find(f => f && f.id === img.id) || null;
                if (fav && fav.placeholderValues) {
                    const pseudo = {
                        templateId: fav.requestTemplateId || '',
                        workflowJson: '',
                        placeholderValues: fav.placeholderValues
                    };

                    // 如果模板不存在，尝试从历史记录补齐 workflowJson
                    if ((!pseudo.templateId || !TemplateManager.get(pseudo.templateId)) && fav.requestId) {
                        const rec = this.requestHistory.find(r => r.id === fav.requestId);
                        if (rec) {
                            pseudo.templateId = rec.templateId || pseudo.templateId;
                            pseudo.workflowJson = rec.workflowJson || '';
                        }
                    }

                    await this.applyParamsFromRecord(pseudo);
                    return;
                }
            }

            // 兜底：只要能拿到参数，就应用到当前占位符（不切换 workflow）
            if (this.previewParamValues) {
                const ok = await this.askConfirm('未找到对应的请求记录/模板，仅将参数应用到当前设置，是否继续？', {
                    title: '应用参数',
                    type: 'warning'
                });
                if (!ok) return;

                const allowed = new Set((this.placeholders || []).map(p => p.name));
                const cur = { ...(this.placeholderValues || {}) };
                Object.keys(this.previewParamValues).forEach(k => {
                    if (!allowed.has(k)) return;
                    cur[k] = deepCloneJson(this.previewParamValues[k]);
                });
                this.placeholderValues = cur;
                this.onSizeChange();

                const el = document.getElementById('params-panel');
                if (el && el.scrollIntoView) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
                return;
            }

            this.showUiToast('该图片暂无可用参数。', 'warning');
        },

        copyPreviewText(kind) {
            const v = this.previewParamValues;
            if (!v) {
                this.showUiToast('该图片暂无参数信息。', 'warning');
                return;
            }
            if (kind === 'negative') {
                this.copyText(v.negative_prompt || '', 'Negative Prompt');
                return;
            }
            this.copyText(v.prompt || '', 'Prompt');
        },

        // ========== 图片预览 ==========
        togglePreviewParams() {
            if (!this.previewParamValues) {
                this.showUiToast('该图片暂无参数信息（可能是旧收藏或对应请求已被裁剪）。', 'warning', 2600);
                return;
            }
            this.showPreviewParams = !this.showPreviewParams;
        },

        openPreviewFromHistory(historyId, index) {
            this.previewMode = 'history';
            this.previewHistoryId = historyId;
            this.previewIndex = index;
            this.showPreviewParams = false;
            this.previewDragX = 0;
            this.previewIsDragging = false;
            this.previewIsSwiping = false;
            this.showImageModal = true;

            this.selectedHistoryId = historyId;
            this.selectedHistoryImageIndex = index;
            this.resultsTab = 'history';
        },

        openPreviewFromGallery(index) {
            this.previewMode = 'gallery';
            this.previewHistoryId = '';
            this.previewIndex = index;
            this.showPreviewParams = false;
            this.previewDragX = 0;
            this.previewIsDragging = false;
            this.previewIsSwiping = false;
            this.showImageModal = true;

            this.selectedGalleryIndex = index;
            this.resultsTab = 'gallery';
        },

        openPreviewFromFavorites(index) {
            const total = this.favoriteImages.length;
            if (!total) return;

            const idx = Math.max(0, Math.min(index, total - 1));
            this.previewMode = 'favorites';
            this.previewHistoryId = '';
            this.previewIndex = idx;
            this.selectedFavoriteIndex = idx;
            this.showPreviewParams = false;
            this.previewDragX = 0;
            this.previewIsDragging = false;
            this.previewIsSwiping = false;
            this.showImageModal = true;

            // 打开预览时收起侧边栏
            this.showFavoritesPanel = false;
        },

        closeImageModal() {
            this.showImageModal = false;
            this.previewIndex = 0;
            this.previewHistoryId = '';
            this.showPreviewParams = false;
            this.previewDragX = 0;
            this.previewIsDragging = false;
            this.previewIsSwiping = false;
        },

        previewPrev() {
            if (!this.previewCanPrev) return;
            this.previewTransitionName = 'rp-slide-prev';
            this.previewDragX = 0;
            this.previewIsDragging = false;
            this.previewIsSwiping = false;
            this.previewIndex -= 1;
            this.syncSelectionFromPreview();
        },

        previewNext() {
            if (!this.previewCanNext) return;
            this.previewTransitionName = 'rp-slide-next';
            this.previewDragX = 0;
            this.previewIsDragging = false;
            this.previewIsSwiping = false;
            this.previewIndex += 1;
            this.syncSelectionFromPreview();
        },

        syncSelectionFromPreview() {
            if (this.previewMode === 'favorites') {
                this.selectedFavoriteIndex = this.previewIndex;
                return;
            }
            if (this.previewMode === 'gallery') {
                this.selectedGalleryIndex = this.previewIndex;
                return;
            }

            if (this.previewHistoryId) {
                this.selectedHistoryId = this.previewHistoryId;
            }
            this.selectedHistoryImageIndex = this.previewIndex;
        },

        isTargetInsidePreviewParams(target) {
            if (!target || !target.closest) return false;
            return !!target.closest('.rp-preview-params');
        },

        onPreviewTouchStart(e) {
            if (this.showPreviewParams && this.isTargetInsidePreviewParams(e && e.target)) {
                this.previewIsDragging = false;
                this.previewIsSwiping = false;
                this.previewDragX = 0;
                return;
            }
            if (!e || !e.touches || e.touches.length !== 1) return;
            const t = e.touches[0];
            this.previewTouchStartX = t.clientX;
            this.previewTouchStartY = t.clientY;

            this.previewIsDragging = true;
            this.previewIsSwiping = false;
            this.previewDragX = 0;
        },

        onPreviewTouchMove(e) {
            if (!this.showImageModal) return;
            if (this.showPreviewParams && this.isTargetInsidePreviewParams(e && e.target)) return;
            if (!this.previewIsDragging) return;
            if (!e || !e.touches || e.touches.length !== 1) return;

            const t = e.touches[0];
            const dx = t.clientX - this.previewTouchStartX;
            const dy = t.clientY - this.previewTouchStartY;

            const absX = Math.abs(dx);
            const absY = Math.abs(dy);
            const START_THRESHOLD = 10;

            if (!this.previewIsSwiping) {
                if (absX > absY && absX > START_THRESHOLD) {
                    this.previewIsSwiping = true;
                } else if (absY > absX && absY > START_THRESHOLD) {
                    // 更像是纵向手势，不进入横向拖拽
                    this.previewIsDragging = false;
                    this.previewDragX = 0;
                    return;
                } else {
                    return;
                }
            }

            // 横向拖拽：提供跟手的视觉反馈
            this.previewDragX = dx;
            if (e.cancelable) e.preventDefault();
        },

        onPreviewTouchEnd(e) {
            if (!e || !e.changedTouches || e.changedTouches.length !== 1) return;
            const t = e.changedTouches[0];
            const dx = t.clientX - this.previewTouchStartX;
            const dy = t.clientY - this.previewTouchStartY;

            const absX = Math.abs(dx);
            const absY = Math.abs(dy);
            const SWIPE_THRESHOLD = 50;

            // 结束拖拽
            this.previewIsDragging = false;
            const wasSwiping = this.previewIsSwiping;
            this.previewIsSwiping = false;

            // 回弹
            this.previewDragX = 0;

            if (!wasSwiping) return;
            if (absX < SWIPE_THRESHOLD || absX < absY) return;

            // 避免滑动后触发 click 误关闭预览
            this._previewIgnoreClickUntil = Date.now() + 450;

            if (dx > 0) {
                this.previewPrev();
            } else {
                this.previewNext();
            }
        },

        onPreviewBackgroundClick() {
            if (this._previewIgnoreClickUntil && Date.now() < this._previewIgnoreClickUntil) {
                return;
            }
            this.closeImageModal();
        },

        onGlobalKeydown(e) {
            if (!e) return;

            if (this.uiDialog && this.uiDialog.show) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this.resolveUiDialog(!this.uiDialog.showCancel);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    this.resolveUiDialog(true);
                }
                return;
            }

            // Ctrl+Enter 快捷生成
            const isEnter = e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter';
            if (isEnter && (e.ctrlKey || e.metaKey)) {
                // 有模态框时不触发（避免干扰输入/确认）
                if (this.showImageModal || this.showSettings || this.showSaveTemplate || this.showImportTemplate || this.showPromptPresets) {
                    return;
                }
                if (this.canGenerate && this.canAcceptNewJob) {
                    e.preventDefault();
                    this.generate();
                }
                return;
            }

            if (!this.showImageModal) return;

            if (e.key === 'Escape') {
                this.closeImageModal();
            } else if (e.key === 'ArrowLeft') {
                this.previewPrev();
            } else if (e.key === 'ArrowRight') {
                this.previewNext();
            }
        },

        downloadImage(image) {
            if (!image) return;
            if (image.type === 'base64') {
                const link = document.createElement('a');
                link.href = image.imageUrl;
                link.download = image.filename || 'image.png';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                return;
            }

            if (image.type === 's3_url' && image.data) {
                window.open(image.data, '_blank');
            }
        }
    }
});

app.component('image-upload', ImageUploadComponent);
app.component('prompt-textarea', PromptTextareaComponent);
app.mount('#app');
