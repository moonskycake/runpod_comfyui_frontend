const WORKFLOW_EDITOR_LOAD_ERROR = 'Workflow 编辑器脚本未加载，请刷新页面或检查部署资源';

// 统一库正文按需加载：同时最多 2 个详情请求，只针对当前可见有限页
const LIBRARY_DETAIL_CONCURRENCY = 2;
const LIBRARY_VISIBLE_STEP = 24;
const PROMPT_LOCKED_MESSAGE = '参数已锁定或模板加载中，暂不能修改提示词';

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
// 生图输入图约束：与后台图片检查区分，这里只限制上传端可接受的边界
const IMAGE_UPLOAD_MAX_SIDE = 3000;
// 前端只按请求体预检（payload > 10MB 会被拒），与后台资源库 5 MiB 成品限制无关
const IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 只有 base64 时没有 MIME 信息：按 magic bytes 推断，认不出来再退回 PNG。
 * 这样外部传入 JPEG/WebP 也能显示正确预览，而自己上传的图仍用文件真实 MIME。
 * @param {string} base64
 * @returns {string}
 */
function inferImageMimeFromBase64(base64) {
    const head = String(base64 || '').slice(0, 8);
    if (head.startsWith('/9j/')) return 'image/jpeg';
    if (head.startsWith('iVBOR')) return 'image/png';
    if (head.startsWith('UklGR')) return 'image/webp';
    if (head.startsWith('R0lGO')) return 'image/gif';
    if (head.startsWith('Qk')) return 'image/bmp';
    return 'image/png';
}

/** 递增解码令牌：让在途 FileReader / Image 回调不再写回。 */
function nextImageDecodeToken(host) {
    const next = Number(host && host._decodeToken || 0) + 1;
    if (host) host._decodeToken = next;
    return next;
}

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
    emits: ['update:uploderimagesrc', 'remove'],
    template: `
        <section class="init-images">
            <input type="file" ref="fileInput" @change="handleChooseFile"
                   style="display: none" accept="image/*">
            <div class="scroll-hide border rounded d-flex flex-wrap align-content-center justify-content-center m-2"
                 style="background-color: rgb(41, 40, 40);position: relative;"
                 :style="'height: ' + uploaderHeight + 'px'">
                <div class="m-2 text-light d-flex justify-content-center align-content-center align-items-center h-100 w-100"
                     @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave.prevent="onDragLeave"
                     @drop.prevent="handleDrop"
                     @click="triggerFileInput()"
                     :class="{ 'cursor-pointer': !disabled, 'rp-upload-drop-active': isDragOver }"
                     ref="uploadContainer">
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
            <div v-if="PreviewimageSrc" class="d-flex gap-2 m-2 mt-0">
                <button type="button" class="btn btn-outline-light btn-sm" :disabled="disabled"
                        @click.stop="chooseReplace" title="重新选择一张图片">
                    <i class="bi bi-arrow-repeat"></i> 替换
                </button>
                <button type="button" class="btn btn-outline-danger btn-sm" :disabled="disabled"
                        @click.stop="removeImage" title="移除输入图片，请求将不再携带该图">
                    <i class="bi bi-x-circle"></i> 移除
                </button>
            </div>
            <div v-if="statusMessage" class="small m-2 mt-0 rp-break"
                 :class="statusType === 'danger' ? 'text-danger' : 'text-warning'" role="alert">
                <i class="bi" :class="statusType === 'danger' ? 'bi-exclamation-octagon' : 'bi-exclamation-triangle'"></i>
                {{ statusMessage }}
            </div>
        </section>
    `,
    methods: {
        triggerFileInput() {
            if (this.disabled) return;
            const input = this.$refs.fileInput;
            if (input && typeof input.click === 'function') input.click();
        },
        chooseReplace() {
            if (this.disabled) return;
            this.statusMessage = '';
            this.triggerFileInput();
        },
        onDragEnter() {
            if (this.disabled) return;
            this.isDragOver = true;
        },
        onDragLeave() {
            this.isDragOver = false;
        },
        handleDrop(event) {
            this.isDragOver = false;
            if (this.disabled) return;
            const files = event && event.dataTransfer && event.dataTransfer.files
                ? Array.prototype.slice.call(event.dataTransfer.files)
                : [];
            this.processFiles(files);
        },
        handleChooseFile(event) {
            const target = event && event.target ? event.target : null;
            const files = target && target.files ? Array.prototype.slice.call(target.files) : [];
            if (this.disabled) {
                if (target) target.value = '';
                return;
            }
            this.processFiles(files);
            // 允许再次选择同一个文件
            if (target) target.value = '';
        },
        processFiles(files) {
            const list = (Array.isArray(files) ? files : []).filter(Boolean);
            if (list.length === 0) {
                this.setStatus('没有读到图片文件，请重新选择', 'warning');
                return;
            }
            if (list.length > 1) {
                this.setStatus(`一次只能上传一张图片，已使用第一张（共 ${list.length} 个文件）`, 'warning');
            }
            this.processFile(list[0]);
        },
        processFile(file) {
            if (!file) return;

            const type = String(file.type || '');
            if (!type.startsWith('image/')) {
                this.setStatus('格式不支持：请选择 PNG / JPEG / WebP 等图片文件', 'danger');
                return;
            }
            const size = Number(file.size || 0);
            if (size > IMAGE_UPLOAD_MAX_BYTES) {
                this.setStatus(`图片过大（${formatFileSize(size)}），单图上限 10 MB（base64 会额外膨胀，整体请求另有 10 MB 预检）`, 'danger');
                return;
            }
            if (typeof FileReader !== 'function') {
                this.setStatus('当前浏览器不支持本地图片读取', 'danger');
                return;
            }

            const token = this.nextDecodeToken();
            this.statusMessage = '';
            const reader = new FileReader();
            reader.onload = (e) => {
                if (token !== this._decodeToken) return;
                const result = e && e.target ? String(e.target.result || '') : '';
                this.applyDecodedFile(result, token);
            };
            reader.onerror = () => {
                if (token !== this._decodeToken) return;
                this.setStatus('读取图片失败，请重试或更换文件', 'danger');
            };
            reader.onabort = () => {
                if (token !== this._decodeToken) return;
                this.setStatus('图片读取已取消', 'warning');
            };
            try {
                reader.readAsDataURL(file);
            } catch (e) {
                this.setStatus('读取图片失败：' + (e && e.message ? e.message : '未知错误'), 'danger');
            }
        },
        applyDecodedFile(dataUrl, token) {
            const text = String(dataUrl || '');
            const comma = text.indexOf(',');
            if (comma === -1) {
                this.setStatus('图片数据无效，请重新选择', 'danger');
                return;
            }
            const mime = (text.slice(5, comma).split(';')[0] || 'image/png');
            const base64Data = text.slice(comma + 1);
            if (!base64Data) {
                this.setStatus('图片内容为空，请重新选择', 'danger');
                return;
            }

            // 没有解码能力时（非浏览器环境）直接按读取结果展示
            if (typeof Image !== 'function') {
                this.applyPreview(text, base64Data, mime, token);
                return;
            }

            const probe = new Image();
            probe.onload = () => {
                // 迟到的解码结果不能恢复已移除/已替换的图片
                if (token !== this._decodeToken) return;
                const width = Number(probe.width || 0);
                const height = Number(probe.height || 0);
                if (width > IMAGE_UPLOAD_MAX_SIDE || height > IMAGE_UPLOAD_MAX_SIDE) {
                    this.setStatus(`图片尺寸过大（${width}x${height}），最大支持 ${IMAGE_UPLOAD_MAX_SIDE}x${IMAGE_UPLOAD_MAX_SIDE}`, 'warning');
                    return;
                }
                this.applyPreview(text, base64Data, mime, token);
            };
            probe.onerror = () => {
                if (token !== this._decodeToken) return;
                this.setStatus('图片解码失败，文件可能已损坏', 'danger');
            };
            probe.src = text;
        },
        applyPreview(dataUrl, base64Data, mime, token) {
            if (token !== this._decodeToken) return;
            this.previewMime = mime || 'image/png';
            this.PreviewimageSrc = dataUrl;
            // 记录自己刚发出的值：watch 不要用推断 MIME 覆盖真实 MIME 的预览
            this._ownBase64 = base64Data;
            this.statusMessage = '';
            this.$emit('update:uploderimagesrc', base64Data);
        },
        removeImage() {
            if (this.disabled) return;
            // 让所有在途解码失效，避免迟到结果把旧图恢复回来
            this.nextDecodeToken();
            this._ownBase64 = '';
            this.PreviewimageSrc = null;
            this.previewMime = '';
            this.statusMessage = '';
            this.$emit('update:uploderimagesrc', '');
            this.$emit('remove');
        },
        nextDecodeToken() {
            return nextImageDecodeToken(this);
        },
        setStatus(message, type) {
            const text = String(message || '').trim();
            this.statusMessage = text;
            this.statusType = type === 'danger' ? 'danger' : 'warning';
            if (text) emitUiNotice(text, this.statusType);
        }
    },
    data() {
        return {
            PreviewimageSrc: null,
            previewMime: '',
            statusMessage: '',
            statusType: 'warning',
            isDragOver: false,
            _decodeToken: 0,
            _ownBase64: ''
        };
    },
    watch: {
        uploderimagesrc: {
            immediate: true,
            handler(newVal) {
                const raw = String(newVal || '');
                if (!raw) {
                    nextImageDecodeToken(this);
                    this._ownBase64 = '';
                    this.previewMime = '';
                    this.PreviewimageSrc = null;
                    return;
                }
                // 自己刚上传的值：预览已按文件真实 MIME 设置，不要覆盖
                if (raw === this._ownBase64) return;
                nextImageDecodeToken(this);
                const mime = inferImageMimeFromBase64(raw);
                this.previewMime = mime;
                this.PreviewimageSrc = `data:${mime};base64,${raw}`;
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
        statusTimeoutMs: 20000,

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
        },
        autoSpaceAfterAutocomplete: {
            type: Boolean,
            default: true
        }
    },
    emits: ['update:modelValue', 'focus'],
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
            existingTagKeys: [],
            blurTimer: null
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

            // 分隔符：逗号始终补；开关只控制逗号后的空格（开=", "，关=","）。
            const autoSpace = this.autoSpaceAfterAutocomplete !== false;
            const separator = autoSpace ? ', ' : ',';

            const after = value.slice(tokenEnd);
            if (after[0] === ',') {
                // 已有逗号：绝不重复添加。开时规范化为", "，关时原样保留用户已有空白与光标。
                if (autoSpace) {
                    const existingSpace = after.slice(1).match(/^[ \t]*/)[0];
                    replacement += ', ';
                    tokenEnd += 1 + existingSpace.length;
                }
            } else if (/^\r?\n/.test(after)) {
                const prefix = (value.slice(0, token.start) + replacement).trimEnd();
                if (prefix && !prefix.endsWith(',')) replacement += separator;
            } else if (!after) {
                const trimmed = (value.slice(0, token.start) + replacement).trimEnd();
                if (trimmed && !trimmed.endsWith(',') && !trimmed.endsWith('\n')) replacement += separator;
            } else if (/^[ \t]+/.test(after)) {
                const existingSpace = after.match(/^[ \t]*/)[0];
                // 没有逗号但后面跟着空白：仍需补逗号；开时把空白归一为一个空格（光标落到空格后）。
                replacement += separator;
                if (autoSpace) tokenEnd += existingSpace.length;
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
                const before = el.value || '';
                inserted = document.execCommand('insertText', false, text) && el.value !== before;
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
                if (el.dispatchEvent && typeof Event === 'function') {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
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

        onFocus(event) {
            if (this.blurTimer) {
                clearTimeout(this.blurTimer);
                this.blurTimer = null;
            }
            // 向上通知外层（用于自动展开负向提示词等）
            this.$emit('focus', event);
            // 懒加载 + 初始化一次搜索
            this.updateMenu();
        },

        onBlur() {
            // 延迟关闭，给鼠标点击选择留时间（mousedown 先于 blur）
            if (this.blurTimer) clearTimeout(this.blurTimer);
            this.blurTimer = setTimeout(() => {
                this.blurTimer = null;
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
                if (e.shiftKey || this.menuItems.length === 0) return;
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
            showLibraryImagePreview: false,
            libraryImagePreview: { name: '', url: '' },
            libraryKind: 'template', // 'template' | 'preset' | 'snippet'
            librarySource: 'shared', // 'shared' | 'local'
            librarySearch: '',
            libraryCategory: '',
            libraryLoading: false,
            libraryDetailLoadingId: '',
            // 统一库正文按需加载：只取当前可见有限页，限并发、按 id@发布版本缓存
            libraryVisibleCount: 24,
            libraryDetailCache: {},
            libraryDetailLoading: {},
            libraryDetailErrors: {},
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
            newPromptSnippetTarget: 'positive',
            editingPromptSnippetId: '',
            promptSnippetPresets: [],

            // ========== 片段/预设全文预览（纯文本，可键盘操作） ==========
            showPromptPreview: false,
            promptPreview: {
                kind: '',
                name: '',
                sourceLabel: '',
                positive: '',
                negative: '',
                text: '',
                target: 'positive',
                loading: false,
                error: '',
                origin: '',
                item: null
            },

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
            rightPanelTab: 'results', // 'results' | 'prompts'
            requestHistory: [],
            _historyPersistPromise: null,
            selectedHistoryId: '',
            selectedHistoryImageIndex: 0,
            selectedGalleryIndex: 0,
            galleryImageFit: 'cover',
            // 负向提示词默认折叠，摘要始终可见；编辑正/负时自动展开
            negativePromptExpanded: false,
            // 图库/收藏按图片 id 锚定：新图插到前面时数值索引会漂移
            selectedGalleryImageId: '',
            selectedFavoriteImageId: '',
            previewAnchorImageId: '',
            // 最新提交的任务：即使当前仍在看旧图，也保留一个明确入口
            latestHistoryId: '',
            historyPanelOpen: false,
            historySearch: '',
            historyFilter: 'all', // 'all' | 'running' | 'completed' | 'failed' | 'cancelled'
            // 桌面左右分栏比例（仅当前会话）
            genSplitRatio: 0.44,
            isSplitDragging: false,

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
            // 只保留正在预览的一张图，防止自动历史裁剪打断查看。关闭或翻页后释放。
            previewRetainedImage: null,
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
            },
            // 历史参数回填：先弹摘要（含 Seed 保留/替换），确认后才动草稿
            pendingParamsApply: null,
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

        /** 生成按钮不可用时的可读原因（空字符串 = 可生成）。 */
        generateDisabledReason() {
            const block = this.generateBlocker;
            return block ? block.reason : '';
        },

        /**
         * 生成阻塞说明 + 可定位的修正入口。
         * 顺序：模板加载 → 未配置 → Workflow → 参数 → 并发/队列。
         */
        generateBlocker() {
            const make = (reason, actionLabel, action) => ({ reason, actionLabel, action });
            if (this.templateDetailLoadingId) {
                return make('模板加载中，完成后即可生成', '返回模板', 'template');
            }
            if (!this.isConfigured) {
                return make('未配置 Endpoint 或 API Key', '打开设置', 'settings');
            }
            if (!String(this.workflowJson || '').trim()) {
                return make('还没有载入 Workflow', '选择模板', 'template');
            }
            if (this.workflowError) {
                return make('Workflow 解析失败：' + this.workflowError, '修复 Workflow', 'workflow');
            }
            if (this.placeholderErrors.length > 0) {
                const first = String(this.placeholderErrors[0] || '');
                return make(`参数有误（${this.placeholderErrors.length} 项）：${first}`, '修正参数', 'params');
            }
            if (this.workflowEditorErrors.length > 0) {
                return make('LoRA 参数有误：' + String(this.workflowEditorErrors[0] || ''), '修正参数', 'params');
            }
            if (!this.canAcceptNewJob) {
                const s = this.effectiveGenerationSettings;
                if (s.allowQueue) {
                    return make(`排队已满（${this.queuedJobCount}/${s.maxQueue}），等待或取消后可加入`, '查看任务', 'tasks');
                }
                return make(`并发已满（${this.activeJobCount}/${s.maxConcurrent}），可在设置中开启排队`, '打开设置', 'settings');
            }
            return null;
        },

        /** 生成按钮文案：并发已满且有排队空位时明确为“加入队列”。 */
        generateButtonLabel() {
            if (this.activeJobCount >= this.effectiveGenerationSettings.maxConcurrent
                && this.canAcceptNewJob) {
                return '加入队列';
            }
            return '生成';
        },

        generateButtonTitle() {
            const blocked = this.generateBlocker;
            if (blocked) return blocked.reason;
            if (this.generateButtonLabel === '加入队列') {
                return `加入队列（已排队 ${this.queuedJobCount}） · 快捷键 Ctrl+Enter`;
            }
            return '快捷键 Ctrl+Enter';
        },

        hasNegativePromptField() {
            return (this.placeholders || []).some(p => p && p.name === 'negative_prompt');
        },

        /** 负向默认折叠时仍能看到摘要。 */
        negativePromptSummary() {
            const text = String((this.placeholderValues || {}).negative_prompt || '').trim();
            if (!text) return '（空）';
            return text.length > 60 ? text.slice(0, 60) + '…' : text;
        },

        /**
         * 浮层签名：用字符串避免数组引用每次新建导致 watcher 误报。
         * 对应 index.html 里各浮层的 data-overlay 标记与 z-index 顺序。
         */
        overlaySignatureText() {
            return this.openOverlayKeys().join('|');
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
            return '统一库';
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
                    positive: String(p.prompt || ''),
                    negative: String(p.negative_prompt || ''),
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
                text: String(s.text || ''),
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
                // 搜索只覆盖名称、分类与已加载正文；描述不冒充正文，也不声称全库搜索
                const body = item.kind === 'template' ? String(item.description || '') : this.libraryBodyText(item);
                const haystack = [item.name, body, item.kind === 'template' ? item.category : '']
                    .map(v => String(v || '').toLowerCase()).join('\n');
                return haystack.includes(q);
            });
        },

        libraryVisibleItems() {
            const items = Array.isArray(this.libraryItems) ? this.libraryItems : [];
            const raw = Number(this.libraryVisibleCount);
            const limit = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 24;
            return items.slice(0, limit);
        },

        libraryRemainingCount() {
            const total = Array.isArray(this.libraryItems) ? this.libraryItems.length : 0;
            return Math.max(0, total - this.libraryVisibleItems.length);
        },

        librarySummaries() {
            const out = {};
            (this.libraryVisibleItems || []).forEach(item => {
                out[this.libraryCardKey(item)] = this.buildLibrarySummary(item);
            });
            return out;
        },

        librarySearchNote() {
            if (this.librarySource !== 'shared') return '';
            if (this.libraryKind === 'template') return '';
            return '搜索匹配名称与已加载正文；尚未加载的条目不在范围内，这不是全库正文搜索。';
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

        promptInsertTargetLabel() {
            const field = this.resolveDefaultInsertField();
            if (!field) return '无可用提示词字段';
            return `${this.promptFieldLabel(field)}（最近焦点）`;
        },

        promptApplyScope() {
            return ['prompt', 'negative_prompt'].map(field => ({
                field,
                label: this.promptFieldLabel(field),
                available: this.hasPromptField(field)
            }));
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

        latestHistoryRecord() {
            if (!this.latestHistoryId) return null;
            return (this.requestHistory || []).find(r => r && r.id === this.latestHistoryId) || null;
        },

        /** 最新任务不是当前查看的对象：显示“查看最新”入口。 */
        hasUnseenLatestHistory() {
            const latest = this.latestHistoryRecord;
            if (!latest) return false;
            return latest.id !== this.selectedHistoryId;
        },

        latestHistoryLabel() {
            const latest = this.latestHistoryRecord;
            if (!latest) return '';
            return `${this.formatDateTimeShort(latest.createdAt)} · ${this.historyStatusLabel(latest.status)}`;
        },

        historyFilterOptions() {
            return [
                { value: 'all', label: '全部' },
                { value: 'running', label: '进行中' },
                { value: 'interrupted', label: '查询中断' },
                { value: 'completed', label: '已完成' },
                { value: 'failed', label: '失败' },
                { value: 'cancelled', label: '已取消' }
            ];
        },

        filteredHistoryRecords() {
            const list = Array.isArray(this.requestHistory) ? this.requestHistory : [];
            const q = String(this.historySearch || '').trim().toLowerCase();
            const filter = this.historyFilter || 'all';

            return list.filter(record => {
                if (!record) return false;
                if (filter !== 'all' && this.historyStatusGroup(record.status) !== filter) return false;
                if (!q) return true;
                const name = String(record.templateName || '自定义 Workflow').toLowerCase();
                const values = record.placeholderValues || {};
                const prompt = String(values.prompt || '').toLowerCase();
                const negative = String(values.negative_prompt || '').toLowerCase();
                return name.includes(q) || prompt.includes(q) || negative.includes(q);
            });
        },

        hasActiveHistoryFilters() {
            return !!String(this.historySearch || '').trim() || (this.historyFilter || 'all') !== 'all';
        },

        splitRatioPercent() {
            return Math.round(this.genSplitRatio * 100);
        },

        splitRatioAriaText() {
            const left = Math.round(this.genSplitRatio * 100);
            return `编辑区 ${left}%，结果区 ${100 - left}%`;
        },

        genLayoutStyle() {
            return { '--rp-left-col': `${(this.genSplitRatio * 100).toFixed(2)}%` };
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
            const anchored = images.find(img => img.id === this.selectedGalleryImageId);
            const idx = Math.max(0, Math.min(this.selectedGalleryIndex, images.length - 1));
            return anchored || images[idx];
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
                const images = this.galleryImages;
                const retained = this.previewRetainedImage;
                if (!this.showImageModal || !retained || images.some(img => img.id === retained.id)) return images;
                // 自动裁剪不等于用户删除：当前图片仍可查看、下载或收藏。
                const next = images.slice();
                next.splice(this.clampInt(this.previewIndex, 0, next.length), 0, retained);
                return next;
            }

            const historyId = this.previewHistoryId || (this.selectedHistoryRecord ? this.selectedHistoryRecord.id : '');
            const record = this.requestHistory.find(r => r.id === historyId);
            return record && Array.isArray(record.images) ? record.images : [];
        },

        previewCurrentIndex() {
            const images = this.previewImages;
            const anchored = this.previewAnchorImageId
                ? images.findIndex(img => img.id === this.previewAnchorImageId) : -1;
            return anchored !== -1 ? anchored : this.clampInt(this.previewIndex, 0, Math.max(0, images.length - 1));
        },

        previewImage() {
            return this.previewImages[this.previewCurrentIndex] || null;
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
                return normalize(rec && rec.placeholderValues) || normalize(img.previewPlaceholderValues);
            }

            const historyId = this.previewHistoryId || (this.selectedHistoryRecord ? this.selectedHistoryRecord.id : '');
            const rec = this.requestHistory.find(r => r.id === historyId);
            return normalize(rec && rec.placeholderValues);
        },

        previewCanPrev() {
            return this.previewImages.length > 0 && this.previewCurrentIndex > 0;
        },

        previewCanNext() {
            const images = this.previewImages;
            return images.length > 0 && this.previewCurrentIndex < images.length - 1;
        },

        previewIndicatorText() {
            const total = this.previewImages.length;
            if (!total) return '';
            const idx = this.previewCurrentIndex;
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
        this.loadGalleryImageFit();
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
        this._splitViewportHandler = () => this.onSplitViewportResize();
        window.addEventListener('resize', this._splitViewportHandler);

        this._uiNoticeHandler = (event) => {
            const detail = event && event.detail ? event.detail : {};
            this.showUiToast(detail.message || '', detail.type || 'info');
        };
        window.addEventListener('runpod:ui-notice', this._uiNoticeHandler);

        // 首次渲染后绘制 workflow 图
        this.$nextTick(() => this.queueWorkflowGraphRender());

        // 空闲时预加载标签库（含中文词库），避免首次输入时等待
        this.preloadTagIndexes();
    },

    beforeUnmount() {
        window.removeEventListener('keydown', this.onGlobalKeydown);
        if (this._splitViewportHandler) {
            window.removeEventListener('resize', this._splitViewportHandler);
            this._splitViewportHandler = null;
        }
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

        if (this.isSplitDragging) {
            this.endSplitDrag();
        }
        // 防御：确保分离器监听不泄漏
        window.removeEventListener('pointermove', this.onSplitPointerMove);
        window.removeEventListener('pointerup', this.endSplitDrag);
        window.removeEventListener('pointercancel', this.endSplitDrag);
        window.removeEventListener('blur', this.onSplitWindowBlur);

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
        // 浮层开关：记录触发点、移入焦点，关闭后归还焦点
        overlaySignatureText(next, prev) {
            const prevKeys = String(prev || '').split('|').filter(Boolean);
            const nextKeys = String(next || '').split('|').filter(Boolean);
            const opened = nextKeys.filter(key => !prevKeys.includes(key));
            const closed = prevKeys.filter(key => !nextKeys.includes(key));
            opened.forEach(key => this.focusOverlayOnOpen(key));
            closed.forEach(key => this.restoreOverlayFocus(key));
        },
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
                this.ensureLibrarySummaries(this.libraryVisibleItems);
            }
        },

        libraryKind() {
            this.resetLibraryVisibleLimit();
        },

        librarySource() {
            this.resetLibraryVisibleLimit();
        },

        libraryVisibleItems: {
            immediate: true,
            handler(items) {
                this.ensureLibrarySummaries(items);
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
        }
    },

    methods: {
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

        saveAutocompleteSpacingSetting() {
            const value = this.settings.autoSpaceAfterAutocomplete !== false;
            Settings.save({ ...this.settings, autoSpaceAfterAutocomplete: value });
            this.settings = Settings.get();
            this.settingsForm = { ...this.settingsForm, autoSpaceAfterAutocomplete: value };
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
            if (!p) return false;
            const ok = this.applyPromptPresetContent({
                positive: p.prompt,
                negative: p.negative_prompt,
                label: `预设「${p.name || '未命名'}」`
            });
            if (!ok) return false;
            this.appliedBlockPresetId = p.id;
            this.setPromptPresetMessage(`已应用预设（${this.presetScopeLabel(p)}）`, 'success');
            return true;
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

        resetSnippetEditor() {
            this.newPromptSnippetName = '';
            this.newPromptSnippetText = '';
            this.newPromptSnippetTarget = 'positive';
            this.editingPromptSnippetId = '';
        },

        isLocalPromptSnippet(s) {
            return !!(s && s.id && CatalogClient.sourceOf(s) === 'local');
        },

        openEditSnippet(s) {
            if (!this.isLocalPromptSnippet(s)) return;
            this.editingPromptSnippetId = s.id;
            this.newPromptSnippetName = String(s.name || '');
            this.newPromptSnippetText = String(s.text || '');
            this.newPromptSnippetTarget = s.target === 'negative' ? 'negative' : 'positive';
            this.setPromptPresetMessage('正在编辑本地片段；统一库原件不会被修改', 'info');
        },

        editLocalLibraryItem(item) {
            if (!item || item.kind !== 'snippet' || CatalogClient.sourceOf(item) !== 'local') return;
            this.mainView = 'generate';
            this.openPromptPresets();
            this.promptPresetTab = 'snippets';
            this.openEditSnippet((this.promptSnippetPresets || []).find(s => s && s.id === item.id));
        },

        cancelEditSnippet() {
            this.resetSnippetEditor();
            this.setPromptPresetMessage('已取消编辑', '');
        },

        async saveSnippetPreset() {
            const name = (this.newPromptSnippetName || '').trim();
            const text = String(this.newPromptSnippetText || '').trim();
            const target = this.newPromptSnippetTarget === 'negative' ? 'negative' : 'positive';
            if (!name) {
                this.setPromptPresetMessage('请输入片段名称', 'warning');
                return;
            }
            if (!text) {
                this.setPromptPresetMessage('请输入片段内容', 'warning');
                return;
            }

            const now = Date.now();
            if (this.editingPromptSnippetId) {
                const editing = (this.promptSnippetPresets || []).find(s => s && s.id === this.editingPromptSnippetId);
                if (!editing || CatalogClient.sourceOf(editing) !== 'local') {
                    this.resetSnippetEditor();
                    this.setPromptPresetMessage('只能编辑本地片段副本', 'warning');
                    return;
                }
                const duplicate = (this.promptSnippetPresets || []).find(s => s && s.id !== editing.id && s.name === name);
                if (duplicate) {
                    this.setPromptPresetMessage('已有同名本地片段，请换一个名称', 'warning');
                    return;
                }
                editing.name = name;
                editing.text = text;
                editing.target = target;
                editing.updatedAt = now;
                this.persistPromptPresets();
                this.resetSnippetEditor();
                this.setPromptPresetMessage('已保存本地片段修改', 'success');
                return;
            }

            const existing = (this.promptSnippetPresets || []).find(s => s && s.name === name);
            if (existing) {
                const shouldOverwrite = await this.askConfirm('已存在同名片段，是否覆盖更新？', {
                    title: '覆盖确认',
                    type: 'warning'
                });
                if (!shouldOverwrite) return;
                existing.text = text;
                existing.target = target;
                existing.updatedAt = now;
                this.persistPromptPresets();
                this.resetSnippetEditor();
                this.setPromptPresetMessage('已更新片段', 'success');
                return;
            }

            const s = {
                id: generateLocalId('ps'),
                name,
                text,
                target,
                source: 'local',
                createdAt: now,
                updatedAt: now
            };
            this.promptSnippetPresets = [s, ...(this.promptSnippetPresets || [])].slice(0, 120);
            this.persistPromptPresets();
            this.resetSnippetEditor();
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
            if (!s || !s.text) return false;
            // 未指定字段时才跟随最近焦点；指定字段严格用该字段自己的光标
            const explicit = field !== undefined && field !== null && field !== '';
            const f = explicit ? (field === 'negative_prompt' ? 'negative_prompt' : 'prompt') : null;
            const ok = this.insertSnippetText(String(s.text || ''), f, `片段「${s.name || '未命名'}」`);
            if (!ok) return false;
            const usedField = (this.promptUndo && this.promptUndo.field) || f || this.resolveDefaultInsertField();
            const label = usedField === 'negative_prompt' ? '负向' : '正向';
            this.setPromptPresetMessage(`已插入到${label}提示词`, 'success');
            return true;
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
        openLibraryImagePreview(item) {
            if (!item || !item.preview || !item.preview.url) return;
            this.libraryImagePreview = { name: String(item.name || '资源预览'), url: item.preview.url };
            this.showLibraryImagePreview = true;
        },

        closeLibraryImagePreview() {
            this.showLibraryImagePreview = false;
            this.libraryImagePreview = { name: '', url: '' };
        },

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
            if (this.mainView === 'library') this.ensureLibrarySummaries(this.libraryVisibleItems);
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

        /** 单条详情请求入口（应用入口用，测试可替换，避免真实网络）。 */
        requestCatalogDetail(id) {
            return CatalogClient.fetchCatalogDetail(id);
        },

        async loadCatalogDetail(id, publishedRevision, expectedKind) {
            if (!id) throw new Error('缺少资源 ID');
            const requestedKind = expectedKind === undefined || expectedKind === null ? '' : String(expectedKind);
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
                const detail = await this.requestCatalogDetail(id);
                if (!detail || typeof detail !== 'object' || !detail.data || typeof detail.data !== 'object') {
                    throw new Error('统一库详情无效');
                }
                if (!detail.id) {
                    throw new Error('统一库详情缺少条目 ID，已忽略');
                }
                if (String(detail.id) !== String(id)) {
                    throw new Error('统一库返回了其他条目，已忽略');
                }
                if (detail.kind && requestedKind && String(detail.kind) !== String(requestedKind)) {
                    throw new Error('统一库返回了不同类型的条目，已忽略');
                }
                const gotRaw = detail.publishedRevision;
                const got = gotRaw === undefined || gotRaw === null ? null : Number(gotRaw);
                if (expected !== null && (got === null || got !== expected)) {
                    throw new Error('统一库详情已更新，请重试');
                }
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
            const context = this.capturePromptApplyContext();
            try {
                const detail = await this.loadCatalogDetail(item.id, item.publishedRevision, item.kind);
                if (!this.isPromptApplyContextCurrent(context, '替换')) return false;
                const data = detail.data || {};
                const ok = this.applyPromptPresetContent({
                    positive: data.positive,
                    negative: data.negative,
                    label: `统一库预设「${detail.name}」`
                });
                if (!ok) return false;
                this.mainView = 'generate';
                this.showUiToast('已替换提示词', 'success');
                return true;
            } catch (e) {
                this.catalogError = e && e.message ? e.message : '预设载入失败';
                this.showUiToast(this.catalogError, 'danger');
                return false;
            }
        },

        async useCatalogSnippet(item) {
            const context = this.capturePromptApplyContext();
            try {
                const detail = await this.loadCatalogDetail(item.id, item.publishedRevision, item.kind);
                if (!this.isPromptApplyContextCurrent(context, '插入')) return false;
                const data = detail.data || {};
                const target = data.target === 'negative' ? 'negative_prompt' : 'prompt';
                const ok = this.insertSnippetText(data.text, target, `统一库片段「${detail.name}」`);
                if (!ok) return false;
                this.mainView = 'generate';
                return true;
            } catch (e) {
                this.catalogError = e && e.message ? e.message : '片段载入失败';
                this.showUiToast(this.catalogError, 'danger');
                return false;
            }
        },

        async copyLibraryItemToLocal(item) {
            if (!item || CatalogClient.sourceOf(item) !== 'shared') return;
            try {
                const detail = await this.loadCatalogDetail(item.id, item.publishedRevision, item.kind);
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
        promptFieldLabel(field) {
            return field === 'negative_prompt' ? '负向提示词' : '正向提示词';
        },

        hasPromptField(field) {
            return !!this.placeholderValues
                && Object.prototype.hasOwnProperty.call(this.placeholderValues, field);
        },

        promptFieldsSignature() {
            return Object.keys(this.placeholderValues || {}).sort().join(',');
        },

        /** 异步应用提示词前固化的上下文：模板 ID + 提示词字段集合。 */
        capturePromptApplyContext() {
            return {
                templateId: String(this.selectedTemplateId || ''),
                signature: this.promptFieldsSignature()
            };
        },

        /**
         * 异步应用完成时确认上下文未被替换：模板已切换/字段已变/参数已锁定均终止
         * 应用，避免旧片段写到新模板。
         */
        isPromptApplyContextCurrent(context, action) {
            const ctx = context || {};
            const label = action || '应用';
            if (this.isParamsLocked) {
                this.showUiToast(`模板加载中或参数已锁定，已取消${label}`, 'warning');
                return false;
            }
            if (String(this.selectedTemplateId || '') !== String(ctx.templateId || '')) {
                this.showUiToast(`模板已切换，已取消${label}`, 'info');
                return false;
            }
            if (this.promptFieldsSignature() !== String(ctx.signature || '')) {
                this.showUiToast(`提示词字段已变化，已取消${label}`, 'warning');
                return false;
            }
            return true;
        },

        /**
         * 模板切换/内容重建后，旧的光标位置与 DOM 引用都不能再用。
         * 只在同一模板内记录；切换模板时显式清空。
         */
        resetPromptCaretTracking() {
            this._lastPromptCaret = null;
            this._promptCarets = {};
            this.lastPromptField = '';
        },

        resolveDefaultInsertField() {
            const active = this._lastPromptCaret;
            if (active && active.field && this.hasPromptField(active.field)) return active.field;
            if (this.hasPromptField('prompt')) return 'prompt';
            if (this.hasPromptField('negative_prompt')) return 'negative_prompt';
            return '';
        },

        presetScopeLabel(preset) {
            const source = preset || {};
            const positive = String(source.prompt !== undefined ? source.prompt : (source.positive || ''));
            const negative = String(source.negative_prompt !== undefined ? source.negative_prompt : (source.negative || ''));
            const parts = [];
            if (this.hasPromptField('prompt') || this.hasPromptField('negative_prompt')) {
                const replaced = [];
                const skipped = [];
                if (this.hasPromptField('prompt')) replaced.push('正向');
                else skipped.push('正向');
                if (this.hasPromptField('negative_prompt')) replaced.push('负向');
                else skipped.push('负向');
                if (replaced.length) parts.push('覆盖' + replaced.join('、'));
                if (skipped.length) parts.push(`${skipped.join('、')}（模板无此字段，保持不变）`);
                if (!positive && !negative) parts.push('正负为空');
                return parts.join(' · ');
            }
            return '当前模板没有提示词占位符';
        },

        applyPromptPresetContent(content) {
            if (this.isParamsLocked) {
                this.showUiToast(PROMPT_LOCKED_MESSAGE, 'warning');
                return false;
            }
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
                label: String((content && content.label) || '预设'),
                field: hasPositive ? 'prompt' : 'negative_prompt'
            };
            if (hasPositive) next.prompt = String(content && content.positive || '');
            if (hasNegative) next.negative_prompt = String(content && content.negative || '');
            this.placeholderValues = next;
            // 整块替换后旧光标位置失效
            this.resetPromptCaretTracking();
            this.focusPromptField(this.promptUndo.field);
            return true;
        },

        undoPromptApply() {
            const undo = this.promptUndo;
            if (!undo) return;
            if (this.isParamsLocked) {
                this.showUiToast(PROMPT_LOCKED_MESSAGE, 'warning');
                return;
            }
            const next = { ...(this.placeholderValues || {}) };
            if (undo.prompt !== undefined) next.prompt = undo.prompt;
            if (undo.negative_prompt !== undefined) next.negative_prompt = undo.negative_prompt;
            this.placeholderValues = next;
            this.promptUndo = null;
            this.resetPromptCaretTracking();
            if (undo.field) this.focusPromptField(undo.field);
            this.showUiToast('已撤销上次提示词应用', 'info');
        },

        recordPromptCaret(el) {
            if (!el || !el.dataset || !el.dataset.promptField) return;
            const field = el.dataset.promptField;
            // 只有当前模板的提示词字段参与“插入目标”，其他/旧模板 textarea 一律忽略
            if (!this.hasPromptField(field)) return;
            const values = this.placeholderValues || {};
            const text = String(el.value !== undefined ? el.value : (values[field] || ''));
            const record = {
                field,
                start: Number.isFinite(el.selectionStart) ? el.selectionStart : 0,
                end: Number.isFinite(el.selectionEnd) ? el.selectionEnd : 0,
                text
            };
            this.lastPromptField = field;
            this._lastPromptCaret = record;
            this._promptCarets = { ...(this._promptCarets || {}), [field]: record };
        },

        /** 记录所属文本已变（模板切换/预设覆盖）时不能复用旧位置。 */
        validCaretRecord(record) {
            if (!record || !record.field) return null;
            if (!this.hasPromptField(record.field)) return null;
            let current = '';
            try {
                current = String((this.placeholderValues || {})[record.field] || '');
            } catch (e) {
                return null;
            }
            if (typeof record.text === 'string' && record.text !== current) return null;
            return record;
        },

        /**
         * 明确目标字段时只用该字段自己的光标记录；不传目标字段才跟随最近焦点。
         */
        resolveSnippetField(targetField) {
            const explicit = targetField !== undefined && targetField !== null && targetField !== '';
            if (!explicit) {
                const active = this._lastPromptCaret;
                if (!active || !active.field) return null;
                return this.validCaretRecord(active);
            }
            const field = targetField === 'negative_prompt' ? 'negative_prompt' : 'prompt';
            const stored = (this._promptCarets || {})[field]
                || (this._lastPromptCaret && this._lastPromptCaret.field === field ? this._lastPromptCaret : null);
            return this.validCaretRecord(stored);
        },

        focusPromptField(field, caret) {
            const target = field === 'negative_prompt' || field === 'prompt' ? field : '';
            if (!target) return;
            // 资源库视图下编辑器是 v-show 隐藏的：先回到生图视图再聚焦
            if (this.mainView !== 'generate') this.mainView = 'generate';
            if (!this.paramSectionsOpen || this.paramSectionsOpen.prompt === false) {
                this.paramSectionsOpen = { ...(this.paramSectionsOpen || {}), prompt: true };
            }
            if (target === 'negative_prompt') this.negativePromptExpanded = true;
            this.$nextTick(() => {
                let el = null;
                try {
                    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
                        el = document.querySelector(`textarea[data-prompt-field="${target}"]`);
                    }
                } catch (e) {
                    el = null;
                }
                if (!el || typeof el.focus !== 'function') return;
                el.focus();
                if (caret === undefined || caret === null) return;
                try { el.setSelectionRange(caret, caret); } catch (e) { /* ignore */ }
            });
        },

        insertSnippetText(text, targetField, label) {
            const snippet = String(text || '').trim();
            if (!snippet) return false;
            if (this.isParamsLocked) {
                this.showUiToast(PROMPT_LOCKED_MESSAGE, 'warning');
                return false;
            }
            const explicit = targetField !== undefined && targetField !== null && targetField !== '';
            const requested = explicit
                ? (targetField === 'negative_prompt' ? 'negative_prompt' : 'prompt')
                : '';
            const record = this.resolveSnippetField(explicit ? requested : null);
            let field = explicit ? requested : (record ? record.field : this.resolveDefaultInsertField());
            if (!field || !this.hasPromptField(field)) {
                const what = explicit ? this.promptFieldLabel(requested) : '提示词';
                this.showUiToast(`当前模板没有${what}字段，未插入`, 'warning');
                return false;
            }

            const values = { ...(this.placeholderValues || {}) };
            const before = String(values[field] || '');
            let start = record ? Number(record.start) : before.length;
            let end = record ? Number(record.end) : before.length;
            if (!Number.isFinite(start)) start = before.length;
            if (!Number.isFinite(end)) end = before.length;
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
            const nextRecord = { field, start: caret, end: caret, text: nextValue };
            this._lastPromptCaret = nextRecord;
            this._promptCarets = { ...(this._promptCarets || {}), [field]: nextRecord };
            this.lastPromptField = field;
            this.promptUndo = {
                prompt: Object.prototype.hasOwnProperty.call(values, 'prompt') ? prevPrompt : undefined,
                negative_prompt: Object.prototype.hasOwnProperty.call(values, 'negative_prompt') ? prevNegative : undefined,
                label: String(label || '片段'),
                field
            };
            this.focusPromptField(field, caret);
            if (label) {
                this.showUiToast(`已应用${label}（${this.promptFieldLabel(field)}）`, 'success');
            }
            return true;
        },

        // ========== 统一库正文按需加载（有限页 / 限并发 / 按版本缓存） ==========
        libraryDetailKey(item) {
            const raw = item ? item.publishedRevision : null;
            const revision = raw === undefined || raw === null || !Number.isFinite(Number(raw)) ? '' : String(Number(raw));
            return `${String(item && item.id || '')}@${revision}`;
        },

        libraryCardKey(item) {
            const source = CatalogClient.sourceOf(item);
            const revision = source === 'shared'
                ? (item && item.publishedRevision)
                : (item && item.sourceRevision);
            const rev = revision === undefined || revision === null || !Number.isFinite(Number(revision))
                ? ''
                : String(Number(revision));
            return `${source}:${String(item && item.id || '')}@${rev}`;
        },

        libraryBodyText(item) {
            const summary = this.buildLibrarySummary(item);
            if (!summary || !summary.loaded) return '';
            return [summary.positive, summary.negative, summary.text]
                .filter(v => String(v || '').length > 0)
                .join('\n');
        },

        /**
         * 卡片正文：本地直接读本地记录；统一库读已加载详情。
         * 未加载时 loaded=false，绝不退回 description。
         */
        buildLibrarySummary(item) {
            const empty = { loaded: false, loading: false, error: '', source: '', positive: '', negative: '', text: '', target: '' };
            if (!item) return empty;
            const source = CatalogClient.sourceOf(item);
            if (source !== 'shared') {
                return {
                    loaded: true,
                    loading: false,
                    error: '',
                    source: 'local',
                    positive: String(item.positive || ''),
                    negative: String(item.negative || ''),
                    text: String(item.text || ''),
                    target: item.target === 'negative' ? 'negative' : 'positive'
                };
            }
            const key = this.libraryDetailKey(item);
            const detail = (this.libraryDetailCache || {})[key] || null;
            if (detail) {
                const data = detail.data || {};
                return {
                    loaded: true,
                    loading: false,
                    error: '',
                    source: 'shared',
                    positive: String(data.positive || ''),
                    negative: String(data.negative || ''),
                    text: String(data.text || ''),
                    target: data.target === 'negative' ? 'negative' : 'positive'
                };
            }
            return {
                ...empty,
                source: 'shared',
                loading: !!(this.libraryDetailLoading || {})[key],
                error: String((this.libraryDetailErrors || {})[key] || '')
            };
        },

        runLibraryDetailTask(task) {
            return new Promise((resolve, reject) => {
                const run = () => {
                    this._libraryDetailInflight = (this._libraryDetailInflight || 0) + 1;
                    let pending;
                    try {
                        pending = Promise.resolve(task());
                    } catch (e) {
                        pending = Promise.reject(e);
                    }
                    pending.then(resolve, reject).finally(() => {
                        this._libraryDetailInflight = Math.max(0, (this._libraryDetailInflight || 1) - 1);
                        const queue = this._libraryDetailQueue || [];
                        const next = queue.shift();
                        if (typeof next === 'function') next();
                    });
                };
                if ((this._libraryDetailInflight || 0) < LIBRARY_DETAIL_CONCURRENCY) run();
                else (this._libraryDetailQueue || (this._libraryDetailQueue = [])).push(run);
            });
        },

        /** 单条详情请求入口（测试可替换，避免真实网络）。 */
        fetchLibraryDetail(item) {
            return CatalogClient.fetchCatalogDetail(item.id);
        },

        /**
         * 只把与请求版本一致的详情写入缓存；版本不一致的旧回包直接忽略。
         */
        applyLibraryDetail(item, key, detail) {
            if (!item || !detail || typeof detail !== 'object') return null;
            const fail = message => {
                this.libraryDetailErrors = { ...(this.libraryDetailErrors || {}), [key]: message };
                return null;
            };
            if (!detail.id) return fail('统一库正文缺少条目 ID，已忽略');
            if (String(detail.id) !== String(item.id)) return fail('正文返回了其他条目，已忽略');
            if (detail.kind && item.kind && String(detail.kind) !== String(item.kind)) {
                return fail('正文返回了不同类型的条目，已忽略');
            }
            const expectedRaw = item.publishedRevision;
            const expected = expectedRaw === undefined || expectedRaw === null ? null : Number(expectedRaw);
            const gotRaw = detail.publishedRevision;
            const got = gotRaw === undefined || gotRaw === null ? null : Number(gotRaw);
            if (expected !== null && (got === null || got !== expected)) {
                return fail('统一库正文已更新，请重试');
            }
            this.libraryDetailCache = { ...(this.libraryDetailCache || {}), [key]: detail };
            const nextErrors = { ...(this.libraryDetailErrors || {}) };
            delete nextErrors[key];
            this.libraryDetailErrors = nextErrors;
            CatalogClient.saveDetailCache(localStorage, detail);
            return detail;
        },

        async loadLibrarySummary(item, options) {
            if (!item) return null;
            const opts = options || {};
            const key = this.libraryDetailKey(item);
            const cached = (this.libraryDetailCache || {})[key];
            if (cached) return cached;
            const knownError = (this.libraryDetailErrors || {})[key];
            if (knownError && !opts.force) throw new Error(knownError);
            const inflight = this._libraryDetailPromises || (this._libraryDetailPromises = {});
            if (inflight[key]) return inflight[key];

            const rawRevision = item.publishedRevision;
            const revision = rawRevision === undefined || rawRevision === null || !Number.isFinite(Number(rawRevision))
                ? null
                : Number(rawRevision);
            if (!opts.force) {
                const disk = CatalogClient.getCachedDetail(localStorage, item.id, revision);
                if (disk) {
                    const applied = this.applyLibraryDetail(item, key, disk);
                    if (applied) return applied;
                }
            }

            this.libraryDetailLoading = { ...(this.libraryDetailLoading || {}), [key]: true };
            const promise = this.runLibraryDetailTask(() => this.fetchLibraryDetail(item, revision))
                .then(detail => {
                    const applied = this.applyLibraryDetail(item, key, detail);
                    if (!applied) throw new Error((this.libraryDetailErrors || {})[key] || '统一库正文不可用');
                    return applied;
                })
                .catch(error => {
                    const message = error && error.message ? error.message : '正文加载失败';
                    this.libraryDetailErrors = { ...(this.libraryDetailErrors || {}), [key]: message };
                    throw error;
                })
                .finally(() => {
                    const nextLoading = { ...(this.libraryDetailLoading || {}) };
                    delete nextLoading[key];
                    this.libraryDetailLoading = nextLoading;
                    delete inflight[key];
                });
            inflight[key] = promise;
            return promise;
        },

        async retryLibrarySummary(item) {
            if (!item) return null;
            const key = this.libraryDetailKey(item);
            const nextErrors = { ...(this.libraryDetailErrors || {}) };
            delete nextErrors[key];
            this.libraryDetailErrors = nextErrors;
            try {
                return await this.loadLibrarySummary(item, { force: true });
            } catch (e) {
                // 事件处理器再失败不能留下未处理的 Promise；错误已落在 libraryDetailErrors 供内联重试
                return null;
            }
        },

        /**
         * 只为“当前可见有限页”的预设/片段补正文；已加载/加载中/失败待重试的不重复请求。
         */
        ensureLibrarySummaries(items) {
            const list = Array.isArray(items) ? items : [];
            const targets = [];
            list.forEach(item => {
                if (!item || item.kind === 'template') return;
                if (CatalogClient.sourceOf(item) !== 'shared') return;
                const key = this.libraryDetailKey(item);
                if ((this.libraryDetailCache || {})[key]) return;
                if ((this.libraryDetailErrors || {})[key]) return;
                if ((this.libraryDetailLoading || {})[key]) return;
                if ((this._libraryDetailPromises || {})[key]) return;
                targets.push(item);
            });
            targets.forEach(item => {
                this.loadLibrarySummary(item).catch(() => { /* 错误已记录，等用户重试 */ });
            });
            return targets.length;
        },

        showMoreLibraryItems() {
            const raw = Number(this.libraryVisibleCount);
            const current = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : LIBRARY_VISIBLE_STEP;
            this.libraryVisibleCount = current + LIBRARY_VISIBLE_STEP;
        },

        resetLibraryVisibleLimit() {
            this.libraryVisibleCount = LIBRARY_VISIBLE_STEP;
        },

        librarySummaryFor(item) {
            const summaries = this.librarySummaries || {};
            const key = this.libraryCardKey(item);
            return summaries[key] || this.buildLibrarySummary(item);
        },

        // ========== 片段/预设全文预览（纯文本，键盘可达） ==========
        openPromptPreview(spec) {
            const source = spec || {};
            const active = typeof document !== 'undefined' ? document.activeElement : null;
            this._promptPreviewReturnFocus = active && active !== document.body ? active : null;
            // 每次打开递增 token：同一 item 关闭重开后，上一个请求的回包也不得写入
            this._promptPreviewToken = (this._promptPreviewToken || 0) + 1;
            this.promptPreview = {
                kind: source.kind === 'preset' ? 'preset' : 'snippet',
                name: String(source.name || '未命名'),
                sourceLabel: String(source.sourceLabel || ''),
                positive: String(source.positive || ''),
                negative: String(source.negative || ''),
                text: String(source.text || ''),
                target: source.target === 'negative' ? 'negative' : 'positive',
                loading: !!source.loading,
                error: String(source.error || ''),
                origin: String(source.origin || ''),
                item: source.item || null
            };
            this.showPromptPreview = true;
            this.$nextTick(() => {
                const dialog = this.$refs && this.$refs.promptPreviewDialog;
                if (dialog && typeof dialog.focus === 'function') dialog.focus();
            });
        },

        /** 预览对象的稳定身份（不依赖 item 对象引用，兼容 Vue 代理/重建对象）。 */
        promptPreviewIdentity(item) {
            const target = item || (this.promptPreview && this.promptPreview.item) || null;
            if (!target) return '';
            const kind = target.kind === 'preset' ? 'preset' : 'snippet';
            return `${kind}:${this.libraryDetailKey(target)}`;
        },

        openQuickPresetPreview(preset) {
            if (!preset) return;
            this.openPromptPreview({
                kind: 'preset',
                name: preset.name,
                sourceLabel: '本地预设',
                positive: preset.prompt,
                negative: preset.negative_prompt,
                origin: 'quick',
                item: preset
            });
        },

        openQuickSnippetPreview(snippet) {
            if (!snippet) return;
            this.openPromptPreview({
                kind: 'snippet',
                name: snippet.name,
                sourceLabel: '本地片段',
                text: snippet.text,
                target: snippet.target,
                origin: 'quick',
                item: snippet
            });
        },

        /** 资源库卡片：本地直接读正文；统一库按需拉详情，失败可在弹窗内重试。 */
        async openLibraryPromptPreview(item) {
            if (!item || item.kind === 'template') return;
            const kindLabel = item.kind === 'preset' ? '提示词预设' : '片段';
            if (CatalogClient.sourceOf(item) !== 'shared') {
                const summary = this.buildLibrarySummary(item);
                this.openPromptPreview({
                    kind: item.kind,
                    name: item.name,
                    sourceLabel: '本地' + kindLabel,
                    positive: summary.positive,
                    negative: summary.negative,
                    text: summary.text,
                    target: summary.target,
                    origin: 'library',
                    item
                });
                return;
            }
            this.openPromptPreview({
                kind: item.kind,
                name: item.name,
                sourceLabel: '统一库' + kindLabel,
                loading: true,
                origin: 'library',
                item
            });
            await this.fillPromptPreviewFromShared(item, kindLabel);
        },

        async fillPromptPreviewFromShared(item, kindLabel) {
            const label = kindLabel || (item.kind === 'preset' ? '提示词预设' : '片段');
            const token = this._promptPreviewToken;
            const identity = this.promptPreviewIdentity(item);
            const isStale = () => !this.showPromptPreview
                || this._promptPreviewToken !== token
                || this.promptPreviewIdentity() !== identity;
            try {
                const detail = await this.loadLibrarySummary(item, { force: true });
                if (isStale()) return;
                const data = detail.data || {};
                this.promptPreview = {
                    ...this.promptPreview,
                    sourceLabel: '统一库' + label,
                    positive: String(data.positive || ''),
                    negative: String(data.negative || ''),
                    text: String(data.text || ''),
                    target: data.target === 'negative' ? 'negative' : 'positive',
                    loading: false,
                    error: ''
                };
            } catch (error) {
                if (isStale()) return;
                this.promptPreview = {
                    ...this.promptPreview,
                    loading: false,
                    error: error && error.message ? error.message : '正文加载失败'
                };
            }
        },

        async retryPromptPreviewLoad() {
            const item = this.promptPreview && this.promptPreview.item;
            if (!item) return;
            const key = this.libraryDetailKey(item);
            const nextErrors = { ...(this.libraryDetailErrors || {}) };
            delete nextErrors[key];
            this.libraryDetailErrors = nextErrors;
            // 重试也是一次新的请求尝试：旧回包不得再写入
            this._promptPreviewToken = (this._promptPreviewToken || 0) + 1;
            this.promptPreview = { ...this.promptPreview, loading: true, error: '' };
            await this.fillPromptPreviewFromShared(item);
        },

        closePromptPreview(options) {
            const opts = options && typeof options === 'object' ? options : {};
            this.showPromptPreview = false;
            // 关闭后旧请求回包一律丢弃
            this._promptPreviewToken = (this._promptPreviewToken || 0) + 1;
            this.promptPreview = {
                kind: '',
                name: '',
                sourceLabel: '',
                positive: '',
                negative: '',
                text: '',
                target: 'positive',
                loading: false,
                error: '',
                origin: '',
                item: null
            };
            const back = this._promptPreviewReturnFocus;
            this._promptPreviewReturnFocus = null;
            if (opts.restoreFocus === false) return;
            if (back && typeof back.focus === 'function') {
                try { back.focus(); } catch (e) { /* ignore */ }
            }
        },

        promptPreviewPartText(part) {
            const preview = this.promptPreview || {};
            if (part === 'positive') return String(preview.positive || '');
            if (part === 'negative') return String(preview.negative || '');
            return String(preview.text || '');
        },

        async copyPromptPreviewPart(part) {
            const text = this.promptPreviewPartText(part);
            const label = part === 'positive' ? '正向正文' : (part === 'negative' ? '负向正文' : '正文');
            if (!text.trim()) {
                this.showUiToast(`${label}为空，无法复制`, 'warning');
                return false;
            }
            const ok = await this.copyToClipboard(text);
            if (!ok) {
                this.showUiToast('复制失败：浏览器权限限制', 'danger');
                return false;
            }
            this.showUiToast(`${label}已复制`, 'success');
            return true;
        },

        insertPromptPreviewPart(field) {
            const preview = this.promptPreview || {};
            const targetField = field === 'negative_prompt' ? 'negative_prompt' : 'prompt';
            const text = preview.kind === 'preset'
                ? (targetField === 'negative_prompt' ? preview.negative : preview.positive)
                : preview.text;
            const label = `${preview.kind === 'preset' ? '预设内容' : '片段'}「${preview.name || '未命名'}」`;
            const ok = this.insertSnippetText(text, targetField, label);
            if (!ok) return false;
            // 插入已经安排把焦点放回目标输入框：关闭预览时不要再用触发按钮抢焦点
            this.closePromptPreview({ restoreFocus: false });
            this.focusPromptField(targetField, this._lastPromptCaret ? this._lastPromptCaret.start : null);
            return true;
        },

        applyPromptPreviewPreset() {
            const preview = this.promptPreview || {};
            if (preview.kind !== 'preset') return false;
            const ok = this.applyPromptPresetContent({
                positive: preview.positive,
                negative: preview.negative,
                label: `预设「${preview.name || '未命名'}」`
            });
            if (ok) this.closePromptPreview({ restoreFocus: false });
            return ok;
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
            // 模板切换：旧模板的提示词光标/DOM 引用全部作废，不得用于新模板插入
            this.resetPromptCaretTracking();
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
                // 常用尺寸与采样/Seed 不藏深；只收敛输入图与其他参数
                this.paramSectionsOpen = {
                    ...this.paramSectionsOpen,
                    size: true,
                    prompt: true,
                    sampling: true,
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

        onInputImageRemoved() {
            this.inputImageData = '';
            this.inputImageSizeWarning = '';
            if (this.placeholderValues && this.placeholderValues.input_image) {
                this.placeholderValues = { ...this.placeholderValues, input_image: '' };
            }
        },

        toggleNegativePromptSection() {
            this.negativePromptExpanded = !this.negativePromptExpanded;
        },

        /** 只有进入负向字段时自动展开；点击正向字段不改变用户的折叠选择。 */
        onPromptFieldFocus(field) {
            if (field === 'negative_prompt') {
                this.negativePromptExpanded = true;
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
            // 保存是异步的（本地写 + IndexedDB 裁剪）：回包到达时内存可能已经推进
            // （恢复查询成功、用户取消、新记录插入…）。旧快照的裁剪结果只能应用到
            // “自快照以来没有变化”的内存；否则重存最新状态，保证落盘与内存一致。
            const MAX_PERSIST_ATTEMPTS = 3;
            const save = async () => {
                try {
                    for (let attempt = 0; attempt < MAX_PERSIST_ATTEMPTS; attempt++) {
                        const records = this.serializeHistoryForStore();
                        const favorites = this.serializeFavoritesForStore();
                        const signature = this.buildHistoryPersistSignature(records, favorites);
                        const pruned = await window.HistoryStore.save({ records, favorites });
                        const currentSignature = this.buildHistoryPersistSignature(
                            this.serializeHistoryForStore(),
                            this.serializeFavoritesForStore()
                        );
                        if (currentSignature !== signature) {
                            // 这份回包属于旧快照，丢弃其裁剪结果并重存（磁盘已写过旧快照，需要覆盖）
                            continue;
                        }
                        this.applyPrunedRecordsToMemory(pruned.records);
                        this.applyPrunedFavoritesToMemory(pruned.favorites);
                        this.ensureResultsSelection();
                        return;
                    }
                    // 内存持续变化：旧回包一律不应用，交给下一轮持久化收敛
                    this.queuePersistHistory();
                } catch (e) {
                    // 忽略持久化失败
                }
            };
            const previous = this._historyPersistPromise || Promise.resolve();
            const queued = previous.catch(() => {}).then(save);
            const tracked = queued.finally(() => {
                if (this._historyPersistPromise === tracked) this._historyPersistPromise = null;
            });
            this._historyPersistPromise = tracked;
            return tracked;
        },

        /**
         * 持久化快照签名：用于判定回包是否属于旧快照。
         * 必须是完整序列化元数据的比较（仅比 updatedAt 不够：同一毫秒内的多次更新会撞车，
         * 且恢复/取消都会改 status/images/interrupt* 而不一定改 updatedAt）。
         * 故意不做 try/catch：序列化失败就抛错，由 persistHistoryNow 的 save() 捕获并中止本轮，
         * 绝不把“无法比较”当成“未变化”（fail-closed，宁可少裁剪也不能覆盖新状态）。
         */
        buildHistoryPersistSignature(records, favorites) {
            return JSON.stringify({ records: records || [], favorites: favorites || [] });
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
                interruptReason: r.interruptReason || '',
                interruptStage: r.interruptStage || '',
                interruptedAt: r.interruptedAt !== undefined ? r.interruptedAt : null,
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
            this.reanchorImageSelections();
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
            if (this.latestHistoryId && !(this.requestHistory || []).some(r => r && r.id === this.latestHistoryId)) {
                this.latestHistoryId = '';
            }
            if (!Array.isArray(this.requestHistory) || this.requestHistory.length === 0) {
                this.selectedHistoryId = '';
                this.selectedHistoryImageIndex = 0;
                this.selectedGalleryIndex = 0;
                return;
            }

            this.reanchorImageSelections();
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
                interruptReason: '',
                interruptStage: '',
                interruptedAt: null,
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
            // 取消是终态：迟到的结果不得复活已取消记录。
            const current = (this.requestHistory || []).find(r => r && r.id === entryId);
            if (current && current.status === 'CANCELLED') return;

            const images = this.extractImagesFromRunpodData(data);

            if (images.length === 0) {
                const msg = '未在返回结果中找到图片';
                this.recordTaskError(entryId, msg, {
                    extra: {
                        executionTime: data && data.executionTime !== undefined ? data.executionTime : null
                    }
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
                executionTime: data && data.executionTime !== undefined ? data.executionTime : null,
                errorMessage: '',
                interruptReason: '',
                interruptStage: '',
                interruptedAt: null
            });

            // 如果用户当前正在查看该请求，则自动切到第一张
            const hasValidSelection = this.selectedHistoryId
                && (this.requestHistory || []).some(r => r && r.id === this.selectedHistoryId);
            if (!hasValidSelection || this.selectedHistoryId === entryId) {
                this.selectedHistoryId = entryId;
                this.selectedHistoryImageIndex = 0;
                this.selectedGalleryIndex = 0;
            } else if (this.latestHistoryId === entryId) {
                // 用户在看别的记录：完成时只提示、不改当前查看
                this.showUiToast('最新任务已完成；可用结果区的“查看最新”切换', 'success', 2600);
            }

            // 新图插入图库头部后按图片 id 重定位当前查看的图
            this.reanchorImageSelections();

            // 完成后立即持久化（含裁剪）
            await this.persistHistoryNow();
        },

        // 取消可能在网络请求飞行期间发生：以任务标记或记录状态为准确认终态。
        isTaskCancelled(task, historyId) {
            if (task && task.cancelRequested) return true;
            const id = historyId || (task && task.historyId ? task.historyId : '');
            if (!id) return false;
            const record = (this.requestHistory || []).find(r => r && r.id === id);
            return !!(record && record.status === 'CANCELLED');
        },

        isFocusedHistoryId(historyId) {
            if (!historyId) return false;
            const selected = this.selectedHistoryRecord;
            return !!(selected && selected.id === historyId);
        },

        /**
         * 记录任务级错误：始终写入对应 historyId 的记录；顶部错误区只展示
         * 当前查看任务的错误，后台任务失败改用临时通知，避免并发互相覆盖。
         */
        recordTaskError(historyId, message, options = {}) {
            const msg = String(message || '').trim() || '生成失败';
            const patch = {
                status: options.status || 'FAILED',
                errorMessage: msg
            };
            if (options.extra && typeof options.extra === 'object') {
                Object.assign(patch, options.extra);
            }
            this.updateHistoryEntry(historyId, patch);

            if (this.isFocusedHistoryId(historyId)) {
                this.errorMessage = msg;
            } else {
                this.showUiToast(msg, 'danger', 2600);
            }
            return msg;
        },

        /** 读取错误结果里的 HTTP 状态（无 HTTP 响应时返回 null）。 */
        readHttpStatus(result) {
            const raw = result ? result.status : null;
            if (raw === null || raw === undefined || raw === '') return null;
            const n = Number(raw);
            return Number.isFinite(n) ? Math.trunc(n) : null;
        },

        /** 只有远端明确终态才算“远端任务失败/结束”，查询失败不算。 */
        isRemoteTaskFailure(result) {
            const st = String((result && result.status) || '');
            return st === 'FAILED' || st === 'TIMED_OUT' || st === 'CANCELLED';
        },

        getQueryInterruptReasonCode(result) {
            const kind = result && result.errorKind ? String(result.errorKind) : '';
            if (kind === 'protocol') return 'protocol';
            if (kind === 'timeout' || (result && result.timeout)) return 'timeout';
            const status = this.readHttpStatus(result);
            if (status === null) return 'network';
            // 用具体 HTTP 码（http_500 / http_429 / http_401…）便于排查，不合并成区间
            return `http_${status}`;
        },

        /** 状态查询失败文案：明确“查询中断，可恢复”，不冒充远端生成失败。 */
        buildQueryInterruptMessage(result) {
            const kind = result && result.errorKind ? String(result.errorKind) : '';
            const status = this.readHttpStatus(result);
            const timeoutMs = Number(result && result.timeoutMs) || 0;
            const seconds = timeoutMs > 0 ? Math.max(1, Math.round(timeoutMs / 1000)) : 0;
            let cause;
            if (kind === 'protocol') {
                // HTTP 200 但响应无法识别：已停止轮询，但 Job 本身仍可能存在
                cause = '状态查询返回了无法识别的响应（HTTP 200，但缺少有效的 status）';
            } else if (kind === 'timeout' || (result && result.timeout)) {
                cause = seconds
                    ? `状态查询超时（${seconds} 秒内未响应）`
                    : '状态查询超时（远端无响应）';
            } else if (status === 429) {
                cause = '状态查询被限流（HTTP 429）';
            } else if (status !== null && status >= 500) {
                cause = `RunPod 服务暂时不可用（HTTP ${status}）`;
            } else if (status === 401) {
                cause = '状态查询鉴权失败（HTTP 401）：API Key 无效或已过期，请先在设置中修正';
            } else if (status === 404) {
                cause = '状态查询失败（HTTP 404）：端点或 Job 不存在，请核对 Endpoint ID 与 Job ID';
            } else if (status !== null) {
                cause = `状态查询失败（HTTP ${status}）`;
            } else {
                cause = `状态查询网络中断（${(result && result.message) || '网络请求失败'}）`;
            }
            return `查询中断，可恢复：${cause}。远端任务状态未知，未判定为生成失败；可点击“恢复查询”继续查询该 Job。`;
        },

        recordQueryInterrupted(historyId, result) {
            const msg = this.buildQueryInterruptMessage(result);
            this.updateHistoryEntry(historyId, {
                status: 'QUERY_INTERRUPTED',
                errorMessage: msg,
                interruptReason: this.getQueryInterruptReasonCode(result),
                interruptStage: 'poll',
                interruptedAt: Date.now()
            });
            if (this.isFocusedHistoryId(historyId)) {
                this.errorMessage = msg;
            } else {
                this.showUiToast(msg, 'warning', 4000);
            }
            return msg;
        },

        /**
         * 提交阶段失败文案：
         * - errorKind === 'http' / 有 HTTP 状态：远端已明确拒绝，保留原业务消息；
         * - errorKind === 'timeout'：远端可能已受理，提示核对控制台、避免重复提交；
         * - 其余（无 HTTP 响应的网络类/未知错误）：同上提示核对控制台，且不承诺“可恢复”
         *   （本地没有 jobId）。分类只看客户端给出的类型，不再匹配错误文案。
         */
        buildSubmitFailureMessage(result) {
            const kind = result && result.errorKind ? String(result.errorKind) : '';
            const status = this.readHttpStatus(result);
            if (kind === 'http' || status !== null) {
                return (result && result.message) || `提交任务失败（HTTP ${status}）`;
            }
            const timeoutMs = Number(result && result.timeoutMs) || 0;
            const seconds = timeoutMs > 0 ? Math.max(1, Math.round(timeoutMs / 1000)) : 0;
            const isTimeout = kind === 'timeout' || !!(result && result.timeout);
            const cause = kind === 'protocol'
                ? '提交响应无效（HTTP 200，但未返回 Job ID）'
                : isTimeout
                    ? (seconds ? `提交请求超时（${seconds} 秒内未响应）` : '提交请求超时（远端无响应）')
                    : `提交请求网络中断（${(result && result.message) || '网络请求失败'}）`;
            return `${cause}：未拿到 Job ID，无法确认远端是否已受理。请先检查网络，并到 RunPod 控制台核对任务列表后再决定是否重新提交，避免重复提交。`;
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

        /**
         * 单次 /status 查询超时（毫秒）：默认 20s，钳制到 5s–120s。
         * 仅用于状态查询；提交 / runsync / 取消的超时不受影响。
         */
        getEffectiveStatusTimeoutMs() {
            const base = (this.settings && typeof this.settings === 'object') ? this.settings : Settings.get();
            const raw = base && base.statusTimeoutMs !== undefined ? base.statusTimeoutMs : 20000;
            const n = Math.trunc(Number(raw));
            if (!Number.isFinite(n) || n <= 0) return 20000;
            return this.clampInt(n, 5000, 120000);
        },

        getEffectiveRunMode() {
            const base = (this.settings && typeof this.settings === 'object') ? this.settings : Settings.get();
            return base && base.runMode === 'runsync' ? 'runsync' : 'run';
        },

        getEffectiveAutoScrollToResults() {
            const base = (this.settings && typeof this.settings === 'object') ? this.settings : Settings.get();
            return !(base && base.autoScrollToResults === false);
        },

        getEffectiveAutoSelectLatestResult() {
            const base = (this.settings && typeof this.settings === 'object') ? this.settings : Settings.get();
            return !(base && base.autoSelectLatestResult === false);
        },

        getClientConfigSnapshot() {
            const base = (this.settings && typeof this.settings === 'object') ? this.settings : Settings.get();
            return {
                endpointId: (base && base.endpointId) || '',
                apiKey: (base && base.apiKey) || '',
                baseUrl: (RunpodClient && RunpodClient.config && RunpodClient.config.baseUrl) || 'https://api.runpod.ai/v2',
                // 状态查询超时随快照下发；恢复查询会重新取快照，因此总是最新设置
                statusTimeoutMs: this.getEffectiveStatusTimeoutMs()
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
            return status === 'IN_PROGRESS'
                || status === 'IN_QUEUE'
                || status === 'SUBMITTING'
                || status === 'QUERY_INTERRUPTED';
        },

        getManualRetryState(record) {
            if (!record || !record.id) {
                return { ok: false, reason: '请求记录不存在' };
            }

            if (!this.isConfigured) {
                return { ok: false, reason: '请先配置 Endpoint 与 API Key' };
            }

            if (!this.isManualRetryableStatus(record.status)) {
                const terminal = String(record.status || '') === 'COMPLETED'
                    || String(record.status || '') === 'FAILED'
                    || String(record.status || '') === 'TIMED_OUT'
                    || String(record.status || '') === 'CANCELLED';
                // 旧 FAILED 记录不因为“可能有 jobId”就开放恢复，只承认显式查询中断。
                return {
                    ok: false,
                    reason: terminal
                        ? '该请求已结束，无需恢复查询'
                        : '仅处理中或查询中断的请求支持恢复查询'
                };
            }

            if (!record.jobId) {
                return {
                    ok: false,
                    reason: '该请求没有 Job ID（提交结果未知），无法继续查询。请先到 RunPod 控制台核对任务列表，避免重复提交。'
                };
            }

            const historyId = record.id;
            const active = (this.activeJobs || []).some(t => t && t.historyId === historyId);
            if (active) {
                return { ok: false, reason: '该请求正在查询中（处理中），请等待当前查询结束' };
            }

            const queued = (this.jobQueue || []).some(t => t && t.historyId === historyId);
            if (queued) {
                return { ok: false, reason: '该请求已在队列中' };
            }

            return { ok: true, reason: '' };
        },

        getManualRetryTitle(record) {
            const state = this.getManualRetryState(record);
            return state.ok ? '点击恢复查询（继续轮询该 Job）' : state.reason;
        },

        /**
         * 恢复按钮的禁用原因：需在正文可见（title 不够）。
         * 只在“查询中断、需要用户行动”时展示；正常处理中/已结束的记录不刷正文噪声。
         */
        getManualRetryBlockedReason(record) {
            if (!record || !record.id) return '';
            if (String(record.status || '') !== 'QUERY_INTERRUPTED') return '';
            const state = this.getManualRetryState(record);
            return state.ok ? '' : state.reason;
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
            this.updateHistoryEntry(historyId, {
                status: 'IN_PROGRESS',
                errorMessage: '',
                interruptReason: '',
                interruptStage: '',
                interruptedAt: null
            });
            this.startTask(task);
            this.showUiToast('已开始恢复查询（继续轮询原 Job）', 'info');
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

                    if (this.isTaskCancelled(task, historyId)) {
                        this.updateHistoryEntry(historyId, { status: 'CANCELLED', errorMessage: '用户取消' });
                        return;
                    }

                    if (result.success) {
                        await this.finalizeHistoryEntry(historyId, result.data);
                    } else {
                        this.recordTaskError(historyId, this.buildSubmitFailureMessage(result));
                    }
                    return;
                }

                const runResult = await RunpodClient.run(payload, clientCfg);
                if (!runResult.success) {
                    if (this.isTaskCancelled(task, historyId)) {
                        this.updateHistoryEntry(historyId, { status: 'CANCELLED', errorMessage: '用户取消' });
                        return;
                    }
                    this.recordTaskError(historyId, this.buildSubmitFailureMessage(runResult));
                    return;
                }

                const jobId = runResult.data && runResult.data.id ? String(runResult.data.id) : '';
                const initStatus = runResult.data && runResult.data.status ? String(runResult.data.status) : 'IN_QUEUE';
                task.jobId = jobId;

                if (this.isTaskCancelled(task, historyId)) {
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
                    // HTTP 200 但没有 id：远端可能已受理，按“未拿到 id”处理并提示核对控制台
                    this.recordTaskError(historyId, this.buildSubmitFailureMessage({
                        success: false,
                        errorKind: 'protocol',
                        status: null,
                        message: '提交响应缺少 job id'
                    }));
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
                        this.recordTaskError(historyId, message, { status: initStatus });
                    }
                    return;
                }

                await this.pollExistingJob(task, historyId, jobId, clientCfg);
            } catch (err) {
                const msg = '生成失败: ' + (err && err.message ? err.message : String(err));
                this.recordTaskError(historyId, msg);
            }
        },

        async pollExistingJob(task, historyId, jobId, clientCfg) {
            const id = jobId ? String(jobId) : '';
            if (!id) {
                this.recordTaskError(historyId, '轮询失败：缺少 job id');
                return;
            }

            const pollResult = await RunpodClient.poll(id, {
                initialDelayMs: task.pollOnly ? 0 : task.initialPollDelayMs,
                intervalMs: task.pollIntervalMs,
                onStatus: (data) => {
                    if (this.isTaskCancelled(task, historyId)) return;
                    // 远端 CANCELLED ≠ 本地用户取消：不在回调里落库，
                    // 否则 isTaskCancelled 会把“在控制台被取消”误标成“用户取消”。
                    if (String((data && data.status) || '') === 'CANCELLED') return;
                    this.updateHistoryEntry(historyId, {
                        status: data.status,
                        delayTime: data.delayTime !== undefined ? data.delayTime : null
                    });
                },
                shouldStop: () => this.isTaskCancelled(task, historyId),
                // 每次 /status 请求前才取最新生效值：设置改过后，尚未发出的查询立即用新超时；
                // endpointId / apiKey / payload 仍用本任务最初快照（不会把旧 Job 发到别的端点）。
                getStatusTimeoutMs: () => this.getEffectiveStatusTimeoutMs()
            }, clientCfg);

            // 取消优先：迟到的 status/run 回包不得恢复任务或记成 FAILED。
            if (this.isTaskCancelled(task, historyId)) {
                this.updateHistoryEntry(historyId, { status: 'CANCELLED', errorMessage: '用户取消' });
                return;
            }

            if (pollResult.success) {
                await this.finalizeHistoryEntry(historyId, pollResult.data);
            } else if (pollResult.cancelled) {
                this.updateHistoryEntry(historyId, { status: 'CANCELLED', errorMessage: '用户取消' });
            } else if (this.isRemoteTaskFailure(pollResult)) {
                // 远端明确终态（FAILED / TIMED_OUT / CANCELLED）才记为任务失败。
                const remoteStatus = String(pollResult.status);
                const message = remoteStatus === 'CANCELLED'
                    ? '远端任务已取消（非本地操作，可能在其他端或 RunPod 控制台被取消）'
                    : pollResult.message;
                this.recordTaskError(historyId, message, { status: remoteStatus });
            } else {
                // 超时 / 无响应网络错误 / HTTP 401/404/429/5xx：查询中断，不是远端失败。
                this.recordQueryInterrupted(historyId, pollResult);
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

            // 用户正在看旧图/图库比较/大图预览时，保留选择、索引、tab 与滚动位置
            const keepView = this.shouldPreserveResultContext();
            this.requestHistory.unshift(historyEntry);
            this.latestHistoryId = historyEntry.id;
            if (!keepView) {
                this.selectedHistoryId = historyEntry.id;
                this.selectedHistoryImageIndex = 0;
                this.selectedGalleryIndex = 0;
                this.resultsTab = 'history';
            }
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

            // 两个行为独立：一个改变当前选中任务，一个只负责跳到结果区域。
            if (this.getEffectiveAutoSelectLatestResult()) {
                this.selectedHistoryId = historyEntry.id;
                this.selectedHistoryImageIndex = 0;
                this.selectedGalleryIndex = 0;
                this.resultsTab = 'history';
            }

            // 若此时并发有空位，立即尝试启动队列
            this.pumpQueue();

            // 生成后滚动到结果区（可在设置 → 生成行为中关闭）；看旧图时不打断
            if (this.getEffectiveAutoScrollToResults()) {
                this.$nextTick(() => this.scrollToResults());
            }
        },

        /**
         * 是否应保留当前结果上下文：已有有效选中、正在图库比较、大图打开或已有旧图。
         */
        shouldPreserveResultContext() {
            const history = Array.isArray(this.requestHistory) ? this.requestHistory : [];
            const hasValidSelection = !!(this.selectedHistoryId && history.some(r => r && r.id === this.selectedHistoryId));
            if (hasValidSelection) return true;
            if (this.resultsTab === 'gallery') return true;
            if (this.showImageModal) return true;
            return history.some(r => r && Array.isArray(r.images) && r.images.length > 0);
        },

        /** 切到最新任务（用户显式操作，允许滚动到结果区）。 */
        selectLatestHistory() {
            const latest = this.latestHistoryRecord;
            if (!latest) return;
            this.selectedHistoryId = latest.id;
            this.selectedHistoryImageIndex = 0;
            this.resultsTab = 'history';
            if (this.getEffectiveAutoScrollToResults()) this.scrollToResults();
        },

        /**
         * 可关闭浮层：按实际 DOM 的 z-index 从低到高排列（末项为最上层）。
         * 各浮层在 index.html 里用 data-overlay 标记，与这里保持一致。
         */
        overlayLayers() {
            return [
                { key: 'favorites', open: !!this.showFavoritesPanel, close: () => this.closeFavoritesPanel() },
                { key: 'image', open: !!this.showImageModal, close: () => this.closeImageModal() },
                { key: 'promptPresets', open: !!this.showPromptPresets, close: () => this.closePromptPresets() },
                { key: 'saveTemplate', open: !!this.showSaveTemplate, close: () => { this.showSaveTemplate = false; } },
                { key: 'importTemplate', open: !!this.showImportTemplate, close: () => { this.showImportTemplate = false; } },
                { key: 'settings', open: !!this.showSettings, close: () => this.closeSettings() },
                { key: 'expose', open: !!this.pendingExposeInput, close: () => this.cancelExposeWorkflowInput() },
                { key: 'paramsApply', open: !!this.pendingParamsApply, close: () => this.resolveParamsApply(false) },
                { key: 'rename', open: !!(this.renameState && this.renameState.show), close: () => { this.renameState.show = false; } },
                { key: 'promptPreview', open: !!this.showPromptPreview, close: () => this.closePromptPreview() },
                { key: 'libraryImage', open: !!this.showLibraryImagePreview, close: () => this.closeLibraryImagePreview() },
                { key: 'uiDialog', open: !!(this.uiDialog && this.uiDialog.show), close: () => this.resolveUiDialog(false) }
            ];
        },

        openOverlayKeys() {
            return this.overlayLayers().filter(layer => layer.open).map(layer => layer.key);
        },

        topOverlayLayer() {
            const open = this.overlayLayers().filter(layer => layer.open);
            return open.length ? open[open.length - 1] : null;
        },

        getOverlayElement(key) {
            if (!key || typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
            try {
                return document.querySelector(`[data-overlay="${key}"]`);
            } catch (e) {
                return null;
            }
        },

        isInsideOverlay(el) {
            return !!(el && typeof el.closest === 'function' && el.closest('[data-overlay]'));
        },

        /** 打开时记录触发点并把焦点移入浮层。 */
        focusOverlayOnOpen(key) {
            // 片段/预设预览有自己的一套焦点逻辑，不重复接管
            if (!key || key === 'promptPreview' || typeof document === 'undefined') return;
            const active = document.activeElement;
            const openingRoot = this.getOverlayElement(key);
            if (active && active !== document.body
                && !(openingRoot && openingRoot.contains(active))) {
                this._overlayTriggers = this._overlayTriggers || {};
                this._overlayTriggers[key] = active;
            }
            this.$nextTick(() => {
                const root = this.getOverlayElement(key);
                if (!root) return;
                const preferred = root.querySelector('[data-overlay-autofocus]');
                const target = preferred || root;
                if (!target) return;
                if (target === root && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
                if (typeof target.focus === 'function') target.focus();
            });
        },

        /** 关闭后把焦点还给触发点；触发点已不在 DOM 时回退到新的最上层。 */
        restoreOverlayFocus(key) {
            if (!key || key === 'promptPreview') return;
            const triggers = this._overlayTriggers || {};
            const trigger = triggers[key];
            delete triggers[key];
            this.$nextTick(() => {
                if (trigger && typeof trigger.focus === 'function' && trigger.isConnected !== false) {
                    try { trigger.focus(); } catch (e) { /* ignore */ }
                    return;
                }
                const top = this.topOverlayLayer();
                if (!top) return;
                const root = this.getOverlayElement(top.key);
                if (root && typeof root.focus === 'function') {
                    if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
                    try { root.focus(); } catch (e) { /* ignore */ }
                }
            });
        },

        /** Tab 焦点陷阱：只在最上层浮层内循环。 */
        trapOverlayTab(event) {
            const top = this.topOverlayLayer();
            if (!top || typeof document === 'undefined') return false;
            const root = this.getOverlayElement(top.key);
            if (!root || typeof root.querySelectorAll !== 'function') return false;
            const selector = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
            const nodes = Array.prototype.slice.call(root.querySelectorAll(selector))
                .filter(el => {
                    if (!el || el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
                    // 被 v-show/CSS 隐形的节点不参与焦点循环
                    if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
                    return true;
                });
            if (nodes.length === 0) {
                event.preventDefault();
                if (typeof root.focus === 'function') {
                    if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
                    root.focus();
                }
                return true;
            }
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            const active = document.activeElement;
            const inside = !!active && root.contains(active);
            if (event.shiftKey && (active === first || !inside)) {
                event.preventDefault();
                last.focus();
                return true;
            }
            if (!event.shiftKey && (active === last || !inside)) {
                event.preventDefault();
                first.focus();
                return true;
            }
            return false;
        },

        /** 输入控件/可编辑区：方向键应留给光标。 */
        isFormFieldTarget(target) {
            if (!target) return false;
            const tag = String(target.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
            if (target.isContentEditable) return true;
            if (typeof target.closest === 'function') {
                if (target.closest('.rp-ac-menu')) return true;
                if (target.closest('[contenteditable="true"]')) return true;
            }
            return false;
        },

        /** 生成阻塞项的定位入口。 */
        focusGenerateBlocker() {
            const blocker = this.generateBlocker;
            if (!blocker) return;
            const scrollToId = (id) => {
                if (typeof document === 'undefined') return;
                const el = document.getElementById(id);
                if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            };
            if (blocker.action === 'settings') {
                this.openSettings();
                return;
            }
            if (blocker.action === 'params') {
                this.mainView = 'generate';
                this.paramSectionsOpen = { ...this.paramSectionsOpen, prompt: true, sampling: true, size: true };
                this.$nextTick(() => {
                    scrollToId('params-panel');
                    const el = typeof document !== 'undefined' ? document.getElementById('params-panel') : null;
                    const firstInvalid = el && el.querySelector ? el.querySelector('.is-invalid, input, textarea') : null;
                    if (firstInvalid && firstInvalid.focus) firstInvalid.focus();
                });
                return;
            }
            if (blocker.action === 'workflow') {
                this.mainView = 'generate';
                this.isWorkflowCollapsed = false;
                this.$nextTick(() => scrollToId('workflow-section'));
                return;
            }
            if (blocker.action === 'tasks') {
                this.mainView = 'generate';
                this.rightPanelTab = 'results';
                this.mobileResultsOpen = true;
                this.historyPanelOpen = true;
                this.$nextTick(() => scrollToId('results-section'));
                return;
            }
            this.mainView = 'generate';
            this.$nextTick(() => scrollToId('template-section'));
        },

        scrollToResults() {
            this.mainView = 'generate';
            this.rightPanelTab = 'results';
            this.mobileResultsOpen = true;
            this.$nextTick(() => {
                const el = document.getElementById('results-section');
                if (el && el.scrollIntoView) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
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
            // 表单以“秒”编辑，内部统一用毫秒；统一走生效值，避免越界值显示异常
            this.settingsForm.statusTimeoutSeconds = Math.round(this.getEffectiveStatusTimeoutMs() / 1000);
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
            this.settingsForm.statusTimeoutSeconds = Math.round(this.getEffectiveStatusTimeoutMs() / 1000);
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
            // 秒 → 毫秒（空值/非数字交给 normalize 回退默认 20s，越界值钳制到 5s–120s）
            const statusTimeoutSeconds = Number(this.settingsForm.statusTimeoutSeconds);
            const statusTimeoutMs = Settings.normalizeStatusTimeoutMs(
                Number.isFinite(statusTimeoutSeconds) ? Math.round(statusTimeoutSeconds * 1000) : NaN
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
                statusTimeoutMs,

                lockParamsOnGenerate,
                allowConcurrent,
                allowQueue,
                maxConcurrent,
                maxQueue,
                autoScrollToResults: !!this.settingsForm.autoScrollToResults,
                autoSelectLatestResult: !!this.settingsForm.autoSelectLatestResult,
                autoSpaceAfterAutocomplete: !!this.settingsForm.autoSpaceAfterAutocomplete
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
            if (status === 'QUERY_INTERRUPTED') return 'bg-warning text-dark';
            if (status === 'IN_PROGRESS') return 'bg-info';
            if (status === 'IN_QUEUE') return 'bg-secondary';
            return 'bg-secondary';
        },

        // ========== 工作区面板（结果 / 预设与片段） ==========
        setRightPanelTab(tab) {
            if (tab !== 'results' && tab !== 'prompts') return;
            this.rightPanelTab = tab;
            if (tab === 'results') {
                this.mobileResultsOpen = true;
            }
        },

        isNarrowLayout() {
            if (typeof window === 'undefined' || !window.matchMedia) return false;
            return !window.matchMedia('(min-width: 1200px)').matches;
        },

        // 提示词标题里的「预设/片段」：切到 prompts，窄屏滚到对应区
        openPromptSidePanel() {
            this.rightPanelTab = 'prompts';
            this.showQuickPromptPanel = true;
            const narrow = this.isNarrowLayout();
            this.$nextTick(() => {
                const el = this.$refs.promptSidePanel;
                if (narrow && el && el.scrollIntoView) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        },

        openResultsPanel() {
            this.scrollToResults();
        },

        toggleHistoryPanel() {
            this.historyPanelOpen = !this.historyPanelOpen;
        },

        clearHistoryFilters() {
            this.historySearch = '';
            this.historyFilter = 'all';
        },

        // ========== 历史状态显示 ==========
        historyStatusLabel(status) {
            const map = {
                SUBMITTING: '提交中',
                IN_QUEUE: '排队中',
                IN_PROGRESS: '运行中',
                COMPLETED: '已完成',
                FAILED: '失败',
                TIMED_OUT: '超时',
                CANCELLED: '已取消',
                QUERY_INTERRUPTED: '查询中断'
            };
            return map[status] || (status ? String(status) : '未知');
        },

        // 筛选分组：提交中/排队/运行归进行中；FAILED/TIMED_OUT 归失败；CANCELLED 单独成组
        historyStatusGroup(status) {
            if (status === 'SUBMITTING' || status === 'IN_QUEUE' || status === 'IN_PROGRESS') return 'running';
            if (status === 'COMPLETED') return 'completed';
            if (status === 'FAILED' || status === 'TIMED_OUT') return 'failed';
            if (status === 'CANCELLED') return 'cancelled';
            if (status === 'QUERY_INTERRUPTED') return 'interrupted';
            return 'other';
        },

        historyRecordThumb(record) {
            const images = record && Array.isArray(record.images) ? record.images : [];
            const first = images[0];
            return first && first.imageUrl ? first.imageUrl : '';
        },

        historyRecordThumbIcon(record) {
            const group = this.historyStatusGroup(record && record.status);
            if (group === 'running') return 'bi-hourglass-split';
            if (group === 'failed') return 'bi-exclamation-triangle';
            if (group === 'interrupted') return 'bi-cloud-slash';
            return 'bi-image';
        },

        historyRecordSummary(record) {
            const values = record && record.placeholderValues ? record.placeholderValues : {};
            const raw = String(values.prompt || values.negative_prompt || '').replace(/\s+/g, ' ').trim();
            if (!raw) return '无提示词';
            return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
        },

        historyEmptyImageText(record) {
            const status = String(record && record.status || '');
            if (status === 'SUBMITTING') return '正在提交请求，稍后会显示任务状态';
            if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') return '任务进行中，完成后会显示图片';
            if (status === 'FAILED' || status === 'TIMED_OUT') return '本次请求未生成图片';
            if (status === 'CANCELLED') return '请求已取消，没有图片';
            if (status === 'QUERY_INTERRUPTED') return '查询中断，任务可能仍在远端运行；可点击“恢复查询”继续查询';
            if (record && record.deletedImages && record.deletedImages.length) return '图片已删除';
            return '这条记录没有图片';
        },

        formatDurationMs(ms) {
            if (ms === null || ms === undefined || ms === '') return '-';
            const num = Number(ms);
            if (!Number.isFinite(num) || num < 0) return '-';
            if (num < 1000) return `${Math.round(num)}ms`;
            return `${(num / 1000).toFixed(num < 10000 ? 1 : 0)}s`;
        },

        // ========== 桌面左右分栏拖动（仅当前会话） ==========
        getSplitBounds() {
            const el = this.$refs.genLayout;
            const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            const width = rect && rect.width > 0 ? rect.width : 1440;
            // 与 CSS 保持一致：左栏 340px、右栏 420px、拖动条 12px、两处 8px 间隙
            const MIN_LEFT_PX = 340;
            const MIN_RIGHT_PX = 420;
            const SPLITTER_PX = 12;
            const GAP_PX = 16;
            const minPx = Math.min(MIN_LEFT_PX, Math.max(1, width - 1));
            const maxPx = Math.max(minPx + 1, width - MIN_RIGHT_PX - SPLITTER_PX - GAP_PX);
            return { width, minPx, maxPx, minRatio: minPx / width, maxRatio: maxPx / width };
        },

        // 窗口变化后重新夹紧旧比例，避免左右栏小于最小宽度
        onSplitViewportResize() {
            // 资源库等隐藏视图下容器宽度为 0，不能拿它回退夹紧，否则比例会被改写
            if (this.mainView !== 'generate') return;
            if (typeof window === 'undefined' || !window.matchMedia) return;
            if (!window.matchMedia('(min-width: 1200px)').matches) return;
            const el = this.$refs.genLayout;
            const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (!rect || !rect.width) return;
            this.setSplitRatio(this.genSplitRatio);
        },

        setSplitRatio(ratio) {
            const bounds = this.getSplitBounds();
            const next = Number.isFinite(Number(ratio)) ? Number(ratio) : 0.44;
            this.genSplitRatio = Math.max(bounds.minRatio, Math.min(bounds.maxRatio, next));
        },

        applySplitFromClientX(clientX) {
            const el = this.$refs.genLayout;
            if (!el || !el.getBoundingClientRect) return;
            const rect = el.getBoundingClientRect();
            if (!rect.width) return;
            this.setSplitRatio((clientX - rect.left) / rect.width);
        },

        startSplitDrag(event) {
            if (event && event.button !== undefined && event.button !== 0) return;
            this.isSplitDragging = true;
            document.body.classList.add('rp-split-dragging');
            const handle = (event && event.currentTarget) || this.$refs.genSplitter;
            if (handle && handle.focus) handle.focus();
            window.addEventListener('pointermove', this.onSplitPointerMove, { passive: false });
            window.addEventListener('pointerup', this.endSplitDrag);
            window.addEventListener('pointercancel', this.endSplitDrag);
            window.addEventListener('blur', this.onSplitWindowBlur);
            if (event && event.preventDefault) event.preventDefault();
        },

        onSplitWindowBlur() {
            if (!this.isSplitDragging) return;
            this.endSplitDrag();
        },

        onSplitPointerMove(event) {
            if (!this.isSplitDragging) return;
            if (event && event.preventDefault) event.preventDefault();
            this.applySplitFromClientX(event.clientX);
        },

        endSplitDrag() {
            this.isSplitDragging = false;
            window.removeEventListener('pointermove', this.onSplitPointerMove);
            window.removeEventListener('pointerup', this.endSplitDrag);
            window.removeEventListener('pointercancel', this.endSplitDrag);
            window.removeEventListener('blur', this.onSplitWindowBlur);
            if (typeof document !== 'undefined' && document.body) {
                document.body.classList.remove('rp-split-dragging');
            }
        },

        onSplitKeydown(event) {
            if (!event) return;
            const step = event.shiftKey ? 0.05 : 0.02;
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                this.setSplitRatio(this.genSplitRatio - step);
            } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                this.setSplitRatio(this.genSplitRatio + step);
            } else if (event.key === 'Home') {
                event.preventDefault();
                this.resetSplitRatio();
            }
        },

        resetSplitRatio() {
            this.genSplitRatio = 0.44;
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

        loadGalleryImageFit() {
            try {
                this.galleryImageFit = localStorage.getItem('runpod_gallery_image_fit') === 'contain' ? 'contain' : 'cover';
            } catch (e) {
                this.galleryImageFit = 'cover';
            }
        },

        setGalleryImageFit(fit) {
            this.galleryImageFit = fit === 'contain' ? 'contain' : 'cover';
            try {
                localStorage.setItem('runpod_gallery_image_fit', this.galleryImageFit);
            } catch (e) {
                // 存储不可用时仍在当前会话生效。
            }
        },

        selectGalleryImage(index) {
            this.resultsTab = 'gallery';
            this.selectedGalleryIndex = index;
            const img = (this.galleryImages || [])[index];
            this.selectedGalleryImageId = img && img.id ? img.id : '';
        },

        /** 新增/裁剪/删除后按图片 id 重定位图库与预览索引。 */
        reanchorImageSelections() {
            const gallery = this.galleryImages || [];
            if (this.selectedGalleryImageId) {
                const idx = gallery.findIndex(img => img && img.id === this.selectedGalleryImageId);
                if (idx !== -1) this.selectedGalleryIndex = idx;
            }
            if (this.showImageModal && this.previewMode === 'gallery') {
                const anchor = this.previewAnchorImageId || this.selectedGalleryImageId;
                const idx = anchor ? this.previewImages.findIndex(img => img && img.id === anchor) : -1;
                if (idx !== -1) {
                    this.previewIndex = idx;
                    const galleryIndex = gallery.findIndex(img => img && img.id === anchor);
                    if (galleryIndex !== -1) {
                        this.selectedGalleryIndex = galleryIndex;
                        this.selectedGalleryImageId = anchor;
                    }
                }
            }
            const favorites = this.favoriteImages || [];
            if (this.selectedFavoriteImageId) {
                const idx = favorites.findIndex(f => f && f.id === this.selectedFavoriteImageId);
                if (idx !== -1) this.selectedFavoriteIndex = idx;
            }
            if (this.showImageModal && this.previewMode === 'favorites') {
                const anchor = this.previewAnchorImageId || this.selectedFavoriteImageId;
                const idx = anchor ? favorites.findIndex(f => f && f.id === anchor) : -1;
                if (idx !== -1) this.previewIndex = idx;
            }
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
            const savedValues = image.favoritePlaceholderValues || image.previewPlaceholderValues;
            const valuesSource = record && record.placeholderValues && typeof record.placeholderValues === 'object'
                ? record.placeholderValues
                : (savedValues && typeof savedValues === 'object' ? savedValues : {});
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
            // 主动删除才释放保留图；记录删除前位置，优先显示下一张，末尾退到上一张。
            if (this.showImageModal && this.previewImage && this.previewImage.id === id) {
                this.previewIndex = this.previewCurrentIndex;
                this.previewAnchorImageId = '';
            }
            if (this.previewRetainedImage && this.previewRetainedImage.id === id) {
                this.previewRetainedImage = null;
            }

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
            this.previewIndex = this.previewCurrentIndex;
            this.syncSelectionFromPreview();
        },

        // ========== 参数回填 ==========
        buildParamsApplySummary(record) {
            const incoming = (record && record.placeholderValues) || {};
            const current = this.placeholderValues || {};
            const labels = {
                prompt: '正向提示词', negative_prompt: '负向提示词', width: '宽度', height: '高度',
                steps: 'Steps', cfg: 'CFG', seed: 'Seed', batch_size: '张数',
                sampler_name: '采样器', scheduler: '调度器', denoise: '重绘幅度'
            };
            const fmt = (value) => {
                const text = String(value === undefined || value === null ? '' : value);
                return text.length > 36 ? text.slice(0, 36) + '…' : text;
            };
            const lines = [];
            let changedCount = 0;

            const targetTemplateId = String((record && record.templateId) || '');
            const currentTemplateId = String(this.selectedTemplateId || '');
            const templateChanged = targetTemplateId !== currentTemplateId;
            const templateName = (record && record.templateName)
                || (targetTemplateId || '自定义 Workflow');
            lines.push(templateChanged
                ? `模板：${this.selectedTemplate && this.selectedTemplate.name ? this.selectedTemplate.name : (currentTemplateId || '自定义 Workflow')} → ${templateName}`
                : `模板：${templateName}（不变）`);

            Object.keys(incoming).forEach(key => {
                const before = current[key];
                const after = incoming[key];
                if (JSON.stringify(before) === JSON.stringify(after)) return;
                changedCount++;
                const label = labels[key] || key;
                if (key === 'prompt' || key === 'negative_prompt') {
                    lines.push(`${label}：${String(before || '').trim() ? '将替换' : '当前为空，将填入'}（${String(after || '').length} 字符）`);
                } else if (key === 'seed') {
                    lines.push(`Seed：${fmt(before)} → ${fmt(after)}`);
                } else if (changedCount <= 8) {
                    lines.push(`${label}：${fmt(before)} → ${fmt(after)}`);
                }
            });
            Object.keys(current).forEach(key => {
                if (Object.prototype.hasOwnProperty.call(incoming, key)) return;
                if (key === 'input_image') return;
                changedCount++;
                if (changedCount <= 8) lines.push(`${labels[key] || key}：将被清除`);
            });
            if (changedCount > 8) lines.push(`…另有 ${changedCount - 8} 项变化`);

            const hasSeed = Object.prototype.hasOwnProperty.call(current, 'seed')
                && Object.prototype.hasOwnProperty.call(incoming, 'seed');
            const seedChanged = hasSeed && String(current.seed) !== String(incoming.seed);
            return { lines, changedCount, templateChanged, hasSeed, seedChanged, currentSeed: current.seed, incomingSeed: incoming.seed };
        },

        async applyParamsFromRecord(record) {
            if (!record) return;
            if (this.isParamsLocked) {
                this.showUiToast(PROMPT_LOCKED_MESSAGE, 'warning');
                return;
            }

            const summary = this.buildParamsApplySummary(record);
            if (!summary.changedCount && !summary.templateChanged) {
                this.showUiToast('当前草稿与这条记录的参数一致，无需应用', 'info');
                return;
            }

            this._paramsApplyToken = (this._paramsApplyToken || 0) + 1;
            const values = this.placeholderValues || {};
            this.pendingParamsApply = {
                token: this._paramsApplyToken,
                summary,
                seedMode: 'keep',
                // 打开对话时就冻结当前 Seed：换模板后 defaults 可能把它覆盖掉
                seedSnapshot: Object.prototype.hasOwnProperty.call(values, 'seed')
                    ? deepCloneJson(values.seed)
                    : undefined,
                seedSnapshotPresent: Object.prototype.hasOwnProperty.call(values, 'seed'),
                // 期望的落点：确认时模板/工作流已被用户改过就拒绝，不静默覆盖
                expectedTemplateId: String(this.selectedTemplateId || ''),
                expectedWorkflowJson: String(this.workflowJson || ''),
                expectedValuesJson: JSON.stringify(values),
                record: {
                    id: record.id || '',
                    templateId: record.templateId || '',
                    templateName: record.templateName || '',
                    workflowJson: record.workflowJson || '',
                    placeholderValues: deepCloneJson(record.placeholderValues || {})
                }
            };
        },

        setParamsApplySeedMode(mode) {
            if (!this.pendingParamsApply) return;
            this.pendingParamsApply = {
                ...this.pendingParamsApply,
                seedMode: mode === 'replace' ? 'replace' : 'keep'
            };
        },

        /** 取消时不改任何草稿。 */
        resolveParamsApply(confirmed) {
            const pending = this.pendingParamsApply;
            if (!pending) return false;
            this.pendingParamsApply = null;
            if (!confirmed) return false;
            if (this._paramsApplyToken !== pending.token) return false;
            if (this.isParamsLocked) {
                this.showUiToast(PROMPT_LOCKED_MESSAGE, 'warning');
                return false;
            }
            // 确认前模板/工作流被改过：拒绝并让用户重新打开摘要，不静默覆盖
            if (String(this.selectedTemplateId || '') !== String(pending.expectedTemplateId || '')
                || String(this.workflowJson || '') !== String(pending.expectedWorkflowJson || '')
                || JSON.stringify(this.placeholderValues || {}) !== pending.expectedValuesJson) {
                this.showUiToast('模板、Workflow 或参数已变化，已取消应用，请重新执行“应用参数”', 'warning', 2600);
                return false;
            }
            this.applyPendingParamsRecord(pending);
            return true;
        },

        applyPendingParamsRecord(pending) {
            const record = (pending && pending.record) || {};
            const keepSeed = pending.seedMode !== 'replace';
            const templateExists = !!(record.templateId && TemplateManager.get(record.templateId));
            const targetTemplateId = templateExists ? String(record.templateId) : '';
            const targetWorkflowJson = templateExists ? '' : String(record.workflowJson || '');
            // shared 模板可能不在本地 TemplateManager：此时靠 record.workflowJson 回退
            const applyValues = () => {
                if (this._paramsApplyToken !== pending.token) return;
                if (String(this.selectedTemplateId || '') !== targetTemplateId) {
                    this.showUiToast('模板已变化，已取消应用', 'warning');
                    return;
                }
                if (targetWorkflowJson && String(this.workflowJson || '') !== targetWorkflowJson) {
                    this.showUiToast('Workflow 已变化，已取消应用', 'warning');
                    return;
                }
                const incoming = deepCloneJson(record.placeholderValues || {});
                if (keepSeed
                    && pending.seedSnapshotPresent
                    && Object.prototype.hasOwnProperty.call(incoming, 'seed')) {
                    // 用打开对话时的快照，避免换模板后 defaults 把 Seed 覆盖成别的值
                    incoming.seed = deepCloneJson(pending.seedSnapshot);
                }
                this.placeholderValues = incoming;
                this.validatePlaceholders();
                this.onSizeChange();
                const el = typeof document !== 'undefined' ? document.getElementById('params-panel') : null;
                if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                this.showUiToast(keepSeed ? '已应用历史参数（Seed 保留当前值）' : '已应用历史参数（含历史 Seed）', 'success');
            };

            if (templateExists) {
                this.selectedTemplateId = record.templateId;
                this.$nextTick(() => this.$nextTick(applyValues));
                return;
            }
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
                const allowed = new Set((this.placeholders || []).map(p => p.name));
                const cur = { ...(this.placeholderValues || {}) };
                Object.keys(this.previewParamValues).forEach(k => {
                    if (!allowed.has(k)) return;
                    cur[k] = deepCloneJson(this.previewParamValues[k]);
                });
                await this.applyParamsFromRecord({
                    templateId: this.selectedTemplateId,
                    templateName: this.selectedTemplate ? this.selectedTemplate.name : '当前 Workflow',
                    workflowJson: this.workflowJson,
                    placeholderValues: cur
                });
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
            this.previewAnchorImageId = '';
            this.previewRetainedImage = null;
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
            const gallery = this.galleryImages;
            if (!gallery.length) return;
            index = this.clampInt(index, 0, gallery.length - 1);
            this.previewRetainedImage = null;
            this.previewMode = 'gallery';
            this.previewHistoryId = '';
            this.previewIndex = index;
            const img = (this.galleryImages || [])[index];
            this.previewAnchorImageId = img && img.id ? img.id : '';
            this.selectedGalleryImageId = this.previewAnchorImageId;
            this.retainGalleryPreviewImage(img);
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
            this.previewRetainedImage = null;
            this.previewHistoryId = '';
            this.previewIndex = idx;
            this.selectedFavoriteIndex = idx;
            const fav = this.favoriteImages[idx];
            this.previewAnchorImageId = fav && fav.id ? fav.id : '';
            this.selectedFavoriteImageId = this.previewAnchorImageId;
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
            this.previewAnchorImageId = '';
            this.previewRetainedImage = null;
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
            const target = this.previewImages[this.previewCurrentIndex - 1];
            this.previewIndex = this.previewCurrentIndex - 1;
            this.previewAnchorImageId = target.id;
            if (this.previewMode === 'gallery') this.retainGalleryPreviewImage(target);
            this.previewIndex = this.previewCurrentIndex;
            this.syncSelectionFromPreview();
        },

        previewNext() {
            if (!this.previewCanNext) return;
            this.previewTransitionName = 'rp-slide-next';
            this.previewDragX = 0;
            this.previewIsDragging = false;
            this.previewIsSwiping = false;
            const target = this.previewImages[this.previewCurrentIndex + 1];
            this.previewIndex = this.previewCurrentIndex + 1;
            this.previewAnchorImageId = target.id;
            if (this.previewMode === 'gallery') this.retainGalleryPreviewImage(target);
            this.previewIndex = this.previewCurrentIndex;
            this.syncSelectionFromPreview();
        },

        retainGalleryPreviewImage(img) {
            if (!img) {
                this.previewRetainedImage = null;
                return;
            }
            const record = this.requestHistory.find(r => r.id === img.requestId);
            this.previewRetainedImage = {
                ...img,
                previewPlaceholderValues: deepCloneJson((record && record.placeholderValues) || img.previewPlaceholderValues || {})
            };
        },

        syncSelectionFromPreview() {
            if (this.previewMode === 'favorites') {
                this.selectedFavoriteIndex = this.previewIndex;
                const fav = this.favoriteImages[this.previewIndex];
                this.selectedFavoriteImageId = fav && fav.id ? fav.id : '';
                this.previewAnchorImageId = this.selectedFavoriteImageId;
                return;
            }
            if (this.previewMode === 'gallery') {
                const img = this.previewImage;
                this.previewAnchorImageId = img && img.id ? img.id : '';
                this.retainGalleryPreviewImage(img);
                const idx = (this.galleryImages || []).findIndex(item => img && item.id === img.id);
                if (idx !== -1) {
                    this.selectedGalleryIndex = idx;
                    this.selectedGalleryImageId = img.id;
                }
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
                if (e.key === 'Tab') this.trapOverlayTab(e);
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this.resolveUiDialog(!this.uiDialog.showCancel);
                }
                // Enter/Space 交给当前聚焦按钮，不能把“取消”键盘操作变成确认。
                return;
            }

            // 焦点陷阱：Tab 只在最上层浮层内循环
            if (e.key === 'Tab' && this.trapOverlayTab(e)) return;

            const top = this.topOverlayLayer();

            // Ctrl+Enter 快捷生成：IME 组合输入、已被处理、浮层内的按键都不触发
            const isEnter = e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter';
            const composing = e.isComposing || e.keyCode === 229;
            if (isEnter && (e.ctrlKey || e.metaKey)) {
                if (composing || e.defaultPrevented || top) return;
                if (this.canGenerate && this.canAcceptNewJob) {
                    e.preventDefault();
                    this.generate();
                }
                return;
            }

            if (!top) return;

            // Esc 只关闭真正最上层（按实际 DOM/z-index）
            if (e.key === 'Escape') {
                e.preventDefault();
                top.close();
                return;
            }

            // 方向键只归最上层图片预览；表单控件内的方向键留给光标
            if (top.key !== 'image') return;
            if (this.isFormFieldTarget(e.target)) return;
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.previewPrev();
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
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
