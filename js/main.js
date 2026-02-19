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
                alert('请选择图片文件');
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                const image = new Image();
                image.src = e.target.result;
                image.onload = () => {
                    // 检查尺寸限制
                    if (image.width > 3000 || image.height > 3000) {
                        alert('图片尺寸过大！最大支持 3000x3000');
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
    return JSON.parse(JSON.stringify(value));
}

/**
 * PromptTextareaComponent
 * - Tag autocomplete for danbooru tags (positive & negative prompt)
 * - Special: token starts with '@' => artist-only search (danbooru category=1)
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
    template: `
        <div class="position-relative">
            <textarea
                ref="ta"
                class="form-control bg-dark text-light border-secondary"
                :rows="rows"
                :placeholder="placeholder"
                :disabled="disabled"
                :value="modelValue"
                @input="onInput"
                @keydown="onKeydown"
                @focus="onFocus"
                @blur="onBlur"
                @compositionstart="onCompositionStart"
                @compositionend="onCompositionEnd"
            ></textarea>

            <div v-if="menuOpen" class="rp-ac-menu position-absolute start-0 top-100 mt-1 w-100">
                <div v-if="menuLoading" class="px-3 py-2 rp-ac-hint">加载词库中...</div>
                <div v-else-if="menuError" class="px-3 py-2 text-danger small">{{ menuError }}</div>
                <div v-else-if="menuItems.length === 0" class="px-3 py-2 rp-ac-hint">无匹配</div>
                <button
                    v-for="(item, idx) in menuItems"
                    :key="item.tag"
                    type="button"
                    class="list-group-item list-group-item-action rp-ac-item d-flex justify-content-between align-items-center"
                    :class="{ active: idx === activeIndex }"
                    @mousedown.prevent="onItemMouseDown(idx)"
                >
                    <span class="d-flex align-items-center gap-2 min-w-0">
                        <span class="rp-ac-tag text-truncate">{{ formatDisplayTag(item.tag) }}</span>
                        <span v-if="item.catLabel" class="badge bg-secondary">{{ item.catLabel }}</span>
                    </span>
                    <span class="text-muted small ms-2">{{ formatCount(item.count) }}</span>
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
            searchSeq: 0
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
        },

        async updateMenu() {
            if (this.isComposing) return;
            const el = this.$refs.ta;
            if (!el) return;

            const value = el.value || '';
            const pos = typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
            const token = this.findToken(value, pos);
            this.lastToken = token;

            const q = (token.query || '').toLowerCase();
            if (!q || q.length < 2) {
                this.closeMenu();
                return;
            }

            const seq = ++this.searchSeq;
            this.menuOpen = true;
            this.menuLoading = true;
            this.menuError = '';

            try {
                if (!window.TagIndex || !window.TagIndex.ensureLoaded) {
                    throw new Error('TagIndex 未加载');
                }
                await window.TagIndex.ensureLoaded();
                if (seq !== this.searchSeq) return;

                const results = window.TagIndex.search(q, { limit: 20, artistOnly: token.artistOnly });
                this.menuItems = (results || []).map(r => ({
                    tag: r.tag,
                    category: r.category,
                    catLabel: this.getCatLabel(r.category),
                    count: r.count
                }));
                this.activeIndex = 0;
                this.menuLoading = false;
            } catch (e) {
                if (seq !== this.searchSeq) return;
                this.menuLoading = false;
                this.menuError = (e && e.message) ? e.message : String(e);
            }
        },

        applySelection(item) {
            if (!item || !item.tag) return;

            const el = this.$refs.ta;
            if (!el) return;
            const value = el.value || '';

            const pos = typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
            const token = this.lastToken || this.findToken(value, pos);

            const before = value.slice(0, token.start);
            const after = value.slice(token.end);

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

            const replacement = `${token.lead || ''}${atPrefix}${tagText}`;

            let nextValue = before + replacement + after;
            let caretPos = (before + replacement).length;

            // 如果是在末尾选择，自动补一个 ", " 方便继续输入
            if (!after) {
                const trimmed = nextValue.trimEnd();
                if (trimmed && !trimmed.endsWith(',') && !trimmed.endsWith('\n')) {
                    nextValue += ', ';
                    caretPos += 2;
                }
            }

            el.value = nextValue;
            try {
                el.setSelectionRange(caretPos, caretPos);
            } catch (e) {
                // ignore
            }

            this.$emit('update:modelValue', nextValue);
            this.closeMenu();
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
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this.menuItems.length === 0) return;
                this.activeIndex = (this.activeIndex - 1 + this.menuItems.length) % this.menuItems.length;
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.closeMenu();
            } else if (e.key === 'Enter' || e.key === 'Tab') {
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
        return {
            // ========== 配置状态 ==========
            isConfigValid: false,
            connectionStatus: '未配置',

            // ========== 模板相关 ==========
            selectedTemplateId: '',
            builtinTemplates: [],
            userTemplates: [],
            selectedTemplate: null,

            // ========== Workflow 相关 ==========
            workflowJson: '',
            workflowError: '',
            workflowObj: null,
            showPreview: false,
            isWorkflowCollapsed: false,
            cursorPosition: 0,

            // ========== 占位符相关 ==========
            placeholders: [],
            placeholderValues: {},
            placeholderErrors: [],
            selectedSizePreset: '',
            seedRandomEachRun: false,

            // ========== 提示词预设 ==========
            showPromptPresets: false,
            promptPresetTab: 'blocks', // 'blocks' | 'snippets'
            promptPresetMessage: '',
            promptPresetMessageType: '', // 'success' | 'danger' | 'warning' | ''
            promptPresetSearch: '',
            newPromptBlockName: '',
            promptBlockPresets: [],
            newPromptSnippetName: '',
            newPromptSnippetText: '',
            promptSnippetPresets: [],

            // ========== 提示词输入体验 ==========
            showPromptInputOptions: false,
            promptInsertOptions: {
                keepUnderscore: true,
                escapeParentheses: true,
                keepAtPrefix: false
            },

            // ========== 输入图片 ==========
            inputImages: [],
            inputImageData: '',
            inputImageSizeWarning: '',

            // ========== 生成状态 ==========
            isGenerating: false,
            currentJobId: '',
            currentJobStatus: '',
            currentHistoryId: '',
            jobStats: {
                delayTime: null,
                executionTime: null
            },
            errorMessage: '',
            shouldStopPolling: false,

            // ========== 结果 ==========
            resultsTab: 'history', // 'history' | 'gallery'
            requestHistory: [],
            selectedHistoryId: '',
            selectedHistoryImageIndex: 0,
            selectedGalleryIndex: 0,

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
            settingsForm: {
                endpointId: '',
                apiKey: '',
                rememberApiKey: false,
                runMode: 'run',
                pollIntervalMs: 2000
            },
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
            previewTouchStartY: 0
        };
    },

    computed: {
        isConfigured() {
            return this.isConfigValid;
        },

        canGenerate() {
            if (!this.isConfigured) return false;
            if (!this.workflowJson.trim()) return false;
            if (this.workflowError) return false;
            if (this.placeholderErrors.length > 0) return false;
            return true;
        },

        canSaveTemplate() {
            return this.workflowJson.trim() && !this.workflowError;
        },

        canUpdateTemplate() {
            return this.selectedTemplate && !this.selectedTemplate.isBuiltin && this.canSaveTemplate;
        },

        canDeleteTemplate() {
            return this.selectedTemplate && !this.selectedTemplate.isBuiltin;
        },

        canTestConnection() {
            return this.settingsForm.endpointId && this.settingsForm.apiKey;
        },

        runModeLabel() {
            return this.settingsForm.runMode === 'run' ? '异步' : '同步';
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

        jobStatusClass() {
            const status = this.currentJobStatus;
            if (status === 'COMPLETED') return 'bg-success';
            if (status === 'FAILED' || status === 'TIMED_OUT') return 'bg-danger';
            if (status === 'CANCELLED') return 'bg-warning';
            return 'bg-info';
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

        // 最终替换后的 workflow
        finalWorkflow() {
            if (!this.workflowObj) return null;
            return PlaceholderEngine.replace(this.workflowObj, this.placeholderValues);
        }
    },

    mounted() {
        // 加载设置
        const settings = Settings.get();
        this.settingsForm = { ...settings };

        // 初始化 RunPod 客户端
        RunpodClient.setConfig({
            endpointId: settings.endpointId,
            apiKey: settings.apiKey
        });

        // 加载内置模板
        TemplateManager.setBuiltinTemplates(window.BuiltinTemplates || []);
        this.builtinTemplates = TemplateManager.builtinTemplates;
        this.loadUserTemplates();

        // 更新配置状态
        this.isConfigValid = Settings.isConfigured();
        this.updateConnectionStatus();

        // 加载持久化历史
        this.loadPersistedHistory();

        // 加载提示词预设
        this.loadPromptPresets();

        // 加载提示词输入选项
        this.loadPromptInsertOptions();

        // 全局按键（图片预览）
        window.addEventListener('keydown', this.onGlobalKeydown);
    },

    beforeUnmount() {
        window.removeEventListener('keydown', this.onGlobalKeydown);

        if (this._persistTimer) {
            clearTimeout(this._persistTimer);
            this._persistTimer = null;
        }

        if (this._promptPresetMsgTimer) {
            clearTimeout(this._promptPresetMsgTimer);
            this._promptPresetMsgTimer = null;
        }
    },

    watch: {
        selectedTemplateId() {
            this.onTemplateSelect();
        },

        selectedSizePreset() {
            this.applySizePreset();
        },

        workflowJson(val) {
            this.parseWorkflow();
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
                this.validatePlaceholders();
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
        }
    },

    methods: {
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

                // 扫描占位符
                this.placeholders = PlaceholderEngine.scan(parsed);

                // 设置默认值
                const defaults = PlaceholderEngine.getDefaults(this.placeholders);
                this.placeholderValues = { ...defaults, ...this.placeholderValues };

                // 如果有模板且模板有 defaults，优先使用模板的
                if (this.selectedTemplate && this.selectedTemplate.defaults) {
                    Object.keys(this.selectedTemplate.defaults).forEach(key => {
                        if (this.placeholderValues.hasOwnProperty(key)) {
                            this.placeholderValues[key] = this.selectedTemplate.defaults[key];
                        }
                    });
                }

                this.validatePlaceholders();
                this.onSizeChange();

            } catch (e) {
                this.workflowError = 'JSON 格式错误: ' + e.message;

                // 即使 JSON 暂时无效，也尽量从文本中扫描占位符，方便用户先填参数
                this.placeholders = PlaceholderEngine.scanText(this.workflowJson);

                const defaults = PlaceholderEngine.getDefaults(this.placeholders);
                this.placeholderValues = { ...defaults, ...this.placeholderValues };

                if (this.selectedTemplate && this.selectedTemplate.defaults) {
                    Object.keys(this.selectedTemplate.defaults).forEach(key => {
                        if (this.placeholderValues.hasOwnProperty(key)) {
                            this.placeholderValues[key] = this.selectedTemplate.defaults[key];
                        }
                    });
                }

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

        togglePromptInputOptions() {
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

        saveCurrentAsBlockPreset() {
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
                if (!confirm('已存在同名预设，是否覆盖更新？')) return;
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

            if (this.placeholderValues && this.placeholderValues.prompt !== undefined) {
                this.placeholderValues.prompt = String(p.prompt || '');
            }
            if (this.placeholderValues && this.placeholderValues.negative_prompt !== undefined) {
                this.placeholderValues.negative_prompt = String(p.negative_prompt || '');
            }

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

        deleteBlockPreset(p) {
            if (!p || !p.id) return;
            if (!confirm(`确定要删除预设 “${p.name}” 吗？`)) return;
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
        },

        saveSnippetPreset() {
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
                if (!confirm('已存在同名片段，是否覆盖更新？')) return;
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

        async copySnippet(text) {
            const ok = await this.copyToClipboard(text);
            if (ok) {
                this.setPromptPresetMessage('已复制到剪贴板', 'success');
            } else {
                this.setPromptPresetMessage('复制失败：浏览器权限限制', 'danger');
            }
        },

        deleteSnippetPreset(s) {
            if (!s || !s.id) return;
            if (!confirm(`确定要删除片段 “${s.name}” 吗？`)) return;
            this.promptSnippetPresets = (this.promptSnippetPresets || []).filter(x => x && x.id !== s.id);
            this.persistPromptPresets();
            this.setPromptPresetMessage('已删除片段', 'success');
        },

        // ========== 模板管理 ==========
        loadUserTemplates() {
            this.userTemplates = TemplateManager.loadUserTemplates();
        },

        onTemplateSelect() {
            if (!this.selectedTemplateId) {
                this.selectedTemplate = null;
                return;
            }

            const template = TemplateManager.get(this.selectedTemplateId);
            if (template) {
                this.selectedTemplate = template;
                let workflow = template.workflow;
                if (typeof workflow === 'string') {
                    try {
                        workflow = JSON.parse(workflow);
                    } catch (e) {
                        this.errorMessage = '模板 workflow 解析失败: ' + e.message;
                        return;
                    }
                }
                this.workflowJson = JSON.stringify(workflow, null, 2);
            }
        },

        saveAsTemplate() {
            this.newTemplateName = '';
            this.newTemplateDescription = '';
            this.showSaveTemplate = true;
        },

        confirmSaveTemplate() {
            if (!this.newTemplateName.trim()) {
                alert('请输入模板名称');
                return;
            }

            try {
                const id = TemplateManager.add({
                    name: this.newTemplateName,
                    description: this.newTemplateDescription,
                    workflow: this.workflowObj,
                    defaults: { ...this.placeholderValues }
                });

                this.loadUserTemplates();
                this.selectedTemplateId = id;
                this.selectedTemplate = TemplateManager.get(id);
                this.showSaveTemplate = false;

                alert('模板保存成功！');
            } catch (e) {
                alert('保存失败: ' + e.message);
            }
        },

        updateTemplate() {
            if (!this.selectedTemplate || this.selectedTemplate.isBuiltin) return;

            if (confirm('确定要更新模板吗？')) {
                TemplateManager.update(this.selectedTemplate.id, {
                    workflow: this.workflowObj,
                    defaults: { ...this.placeholderValues }
                });
                alert('模板已更新！');
            }
        },

        deleteTemplate() {
            if (!this.selectedTemplate || this.selectedTemplate.isBuiltin) return;

            if (confirm('确定要删除此模板吗？')) {
                TemplateManager.delete(this.selectedTemplate.id);
                this.loadUserTemplates();
                this.selectedTemplateId = '';
                this.selectedTemplate = null;
            }
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

                alert('模板导入成功！');
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
            if (this.selectedTemplate && this.selectedTemplate.defaults) {
                this.placeholderValues = { ...this.selectedTemplate.defaults };
            } else {
                const defaults = PlaceholderEngine.getDefaults(this.placeholders);
                this.placeholderValues = { ...defaults };
            }
            this.onSizeChange();
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

            if (data && data.executionTime !== undefined) {
                this.jobStats.executionTime = data.executionTime;
            }

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

            // 默认切换到最新图片
            this.selectedHistoryId = entryId;
            this.selectedHistoryImageIndex = 0;
            this.selectedGalleryIndex = 0;

            // 完成后立即持久化（含裁剪）
            await this.persistHistoryNow();
        },

        // ========== 生成 ==========
        async generate() {
            if (!this.canGenerate) return;

            this.isGenerating = true;
            this.errorMessage = '';
            this.currentJobId = '';
            this.currentJobStatus = '';
            this.currentHistoryId = '';
            this.jobStats = { delayTime: null, executionTime: null };
            this.shouldStopPolling = false;

            // 每次生成前随机 seed
            if (this.seedRandomEachRun && this.hasSeedPlaceholder) {
                this.randomizeSeedOnce();
            }

            // 使用替换后的 workflow
            const finalWorkflow = this.finalWorkflow;

            const payload = {
                input: {
                    workflow: finalWorkflow
                }
            };

            // 添加输入图片
            const validImages = [];

            // 1. 处理占位符形式的输入图片
            if (this.hasInputImagePlaceholder && this.inputImageData) {
                const imageName = this.placeholderValues.input_image || 'input.png';
                validImages.push({
                    name: imageName,
                    image: this.inputImageData
                });
            }

            // 2. 处理列表形式的输入图片（向后兼容）
            this.inputImages
                .filter(img => img.image && img.name)
                .forEach(img => {
                    validImages.push({
                        name: img.name,
                        image: img.image
                    });
                });

            if (validImages.length > 0) {
                payload.input.images = validImages;
            }

            // 估算请求大小
            const payloadSize = JSON.stringify(payload).length;
            if (payloadSize > 10 * 1024 * 1024) {
                this.errorMessage = `请求体过大 (${formatFileSize(payloadSize)})，超过 10MB 限制。请减少输入图片数量或大小。`;
                this.isGenerating = false;
                return;
            }

            const settings = Settings.get();

            // 创建请求历史记录
            const historyEntry = this.createHistoryEntry({
                runMode: settings.runMode,
                endpointId: settings.endpointId,
                payloadSize,
                imageCount: validImages.length
            });
            this.requestHistory.unshift(historyEntry);
            this.selectedHistoryId = historyEntry.id;
            this.selectedHistoryImageIndex = 0;
            this.resultsTab = 'history';
            this.currentHistoryId = historyEntry.id;
            this.queuePersistHistory();

            try {
                if (settings.runMode === 'runsync') {
                    this.currentJobStatus = 'IN_PROGRESS';
                    this.updateHistoryEntry(historyEntry.id, { status: 'IN_PROGRESS' });
                    const result = await RunpodClient.runSync(payload, 300000);

                    if (result.success) {
                        this.currentJobStatus = 'COMPLETED';
                        await this.finalizeHistoryEntry(historyEntry.id, result.data);
                    } else {
                        this.errorMessage = result.message;
                        this.currentJobStatus = 'FAILED';
                        this.updateHistoryEntry(historyEntry.id, { status: 'FAILED', errorMessage: result.message });
                    }
                } else {
                    const runResult = await RunpodClient.run(payload);

                    if (!runResult.success) {
                        this.errorMessage = runResult.message;
                        this.currentJobStatus = 'FAILED';
                        this.updateHistoryEntry(historyEntry.id, { status: 'FAILED', errorMessage: runResult.message });
                        return;
                    }

                    this.currentJobId = runResult.data.id;
                    this.currentJobStatus = runResult.data.status;
                    this.updateHistoryEntry(historyEntry.id, { jobId: this.currentJobId, status: this.currentJobStatus });

                    const pollResult = await RunpodClient.poll(this.currentJobId, {
                        intervalMs: settings.pollIntervalMs,
                        onStatus: (data) => {
                            this.currentJobStatus = data.status;
                            if (data.delayTime !== undefined) {
                                this.jobStats.delayTime = data.delayTime;
                            }

                            this.updateHistoryEntry(historyEntry.id, {
                                status: data.status,
                                delayTime: data.delayTime !== undefined ? data.delayTime : null
                            });
                        },
                        shouldStop: () => this.shouldStopPolling
                    });

                    if (pollResult.success) {
                        this.currentJobStatus = 'COMPLETED';
                        await this.finalizeHistoryEntry(historyEntry.id, pollResult.data);
                    } else if (pollResult.cancelled) {
                        this.currentJobStatus = 'CANCELLED';
                        this.errorMessage = '已取消';
                        this.updateHistoryEntry(historyEntry.id, { status: 'CANCELLED', errorMessage: '已取消' });
                    } else {
                        this.currentJobStatus = pollResult.status || 'FAILED';
                        this.errorMessage = pollResult.message;
                        this.updateHistoryEntry(historyEntry.id, { status: this.currentJobStatus, errorMessage: pollResult.message });
                    }
                }
            } catch (err) {
                this.errorMessage = '生成失败: ' + err.message;
                this.currentJobStatus = 'FAILED';
                this.updateHistoryEntry(historyEntry.id, { status: 'FAILED', errorMessage: this.errorMessage });
            } finally {
                this.isGenerating = false;
                this.currentHistoryId = '';
            }
        },

        async cancelGeneration() {
            this.shouldStopPolling = true;

            if (this.currentHistoryId) {
                this.updateHistoryEntry(this.currentHistoryId, { status: 'CANCELLED', errorMessage: '用户取消' });
            }

            if (this.currentJobId) {
                try {
                    await RunpodClient.cancel(this.currentJobId);
                } catch (err) {
                    // 忽略取消错误
                }
            }

            this.isGenerating = false;
            this.currentJobStatus = 'CANCELLED';
            this.currentHistoryId = '';
        },

        // ========== 设置 ==========
        closeSettings() {
            this.showSettings = false;
            this.connectionTestResult = null;
        },

        saveSettings() {
            Settings.save({
                endpointId: this.settingsForm.endpointId,
                apiKey: this.settingsForm.apiKey,
                rememberApiKey: this.settingsForm.rememberApiKey,
                runMode: this.settingsForm.runMode,
                pollIntervalMs: this.settingsForm.pollIntervalMs
            });

            RunpodClient.setConfig({
                endpointId: this.settingsForm.endpointId,
                apiKey: this.settingsForm.apiKey
            });

            this.isConfigValid = Settings.isConfigured();
            this.updateConnectionStatus();
            this.closeSettings();
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
                alert(`收藏已满（最多 ${maxFav} 张）。请先取消收藏或删除一些图片。`);
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
            const ok = confirm(`确定要删除这张图片吗？\n${filename}\n\n删除后将无法恢复。`);
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
        applyParamsFromRecord(record) {
            if (!record) return;

            const hasChanges = this.workflowJson.trim();
            if (hasChanges) {
                const ok = confirm('这会覆盖当前的模板/参数设置，是否继续？');
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

        // ========== 图片预览 ==========
        togglePreviewParams() {
            if (!this.previewParamValues) {
                alert('该图片暂无参数信息（可能是旧收藏或对应请求已被裁剪）。');
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

        onPreviewTouchStart(e) {
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
            if (!this.showImageModal) return;
            if (!e) return;

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
