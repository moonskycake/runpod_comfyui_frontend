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
            cursorPosition: 0,

            // ========== 占位符相关 ==========
            placeholders: [],
            placeholderValues: {},
            placeholderErrors: [],
            selectedSizePreset: '',

            // ========== 输入图片 ==========
            inputImages: [],
            inputImageData: '',
            inputImageSizeWarning: '',

            // ========== 生成状态 ==========
            isGenerating: false,
            currentJobId: '',
            currentJobStatus: '',
            jobStats: {
                delayTime: null,
                executionTime: null
            },
            errorMessage: '',
            shouldStopPolling: false,

            // ========== 结果 ==========
            results: [],

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

            // ========== 图片预览 ==========
            showImageModal: false,
            selectedImageIndex: -1
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

        jobStatusClass() {
            const status = this.currentJobStatus;
            if (status === 'COMPLETED') return 'bg-success';
            if (status === 'FAILED' || status === 'TIMED_OUT') return 'bg-danger';
            if (status === 'CANCELLED') return 'bg-warning';
            return 'bg-info';
        },

        selectedImage() {
            if (this.selectedImageIndex < 0 || this.selectedImageIndex >= this.results.length) {
                return null;
            }
            return this.results[this.selectedImageIndex];
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
    },

    watch: {
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
            }
        },

        validatePlaceholders() {
            const result = PlaceholderEngine.validate(this.placeholders, this.placeholderValues);
            this.placeholderErrors = Object.values(result.errors);
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
            this.showImportTemplate = true;
        },

        handleImportFile(event) {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (e) => {
                this.importTemplateJson = e.target.result;
                event.target.value = '';
            };
            reader.readAsText(file);
        },

        confirmImportTemplate() {
            if (!this.importTemplateJson.trim()) {
                this.importError = '请输入模板 JSON';
                return;
            }

            try {
                const imported = TemplateManager.importTemplate(this.importTemplateJson);
                const id = TemplateManager.add(imported);

                this.loadUserTemplates();
                this.selectedTemplateId = id;
                this.onTemplateSelect();
                this.showImportTemplate = false;

                alert('模板导入成功！');
            } catch (e) {
                this.importError = e.message;
            }
        },

        // ========== 尺寸预设 ==========
        applySizePreset() {
            if (!this.selectedSizePreset) return;
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

        // ========== 生成 ==========
        async generate() {
            if (!this.canGenerate) return;

            this.isGenerating = true;
            this.errorMessage = '';
            this.currentJobId = '';
            this.currentJobStatus = '';
            this.jobStats = { delayTime: null, executionTime: null };
            this.shouldStopPolling = false;

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

            try {
                if (settings.runMode === 'runsync') {
                    this.currentJobStatus = 'IN_PROGRESS';
                    const result = await RunpodClient.runSync(payload, 300000);

                    if (result.success) {
                        this.handleCompletedResult(result.data);
                    } else {
                        this.errorMessage = result.message;
                    }
                } else {
                    const runResult = await RunpodClient.run(payload);

                    if (!runResult.success) {
                        this.errorMessage = runResult.message;
                        this.isGenerating = false;
                        return;
                    }

                    this.currentJobId = runResult.data.id;
                    this.currentJobStatus = runResult.data.status;

                    const pollResult = await RunpodClient.poll(this.currentJobId, {
                        intervalMs: settings.pollIntervalMs,
                        onStatus: (data) => {
                            this.currentJobStatus = data.status;
                            if (data.delayTime !== undefined) {
                                this.jobStats.delayTime = data.delayTime;
                            }
                        },
                        shouldStop: () => this.shouldStopPolling
                    });

                    if (pollResult.success) {
                        this.handleCompletedResult(pollResult.data);
                    } else if (pollResult.cancelled) {
                        this.currentJobStatus = 'CANCELLED';
                        this.errorMessage = '已取消';
                    } else {
                        this.currentJobStatus = pollResult.status || 'FAILED';
                        this.errorMessage = pollResult.message;
                    }
                }
            } catch (err) {
                this.errorMessage = '生成失败: ' + err.message;
            } finally {
                this.isGenerating = false;
            }
        },

        handleCompletedResult(data) {
            this.currentJobStatus = 'COMPLETED';

            if (data.executionTime !== undefined) {
                this.jobStats.executionTime = data.executionTime;
            }

            const output = data.output;
            if (!output) {
                this.errorMessage = '返回结果中没有 output 字段';
                return;
            }

            const images = [];

            if (output.images && Array.isArray(output.images)) {
                output.images.forEach(img => {
                    if (img.type === 'base64') {
                        images.push({
                            filename: img.filename || 'image.png',
                            type: 'base64',
                            data: img.data,
                            imageUrl: `data:image/png;base64,${img.data}`
                        });
                    } else if (img.type === 's3_url') {
                        images.push({
                            filename: img.filename || 'image.png',
                            type: 's3_url',
                            data: img.data
                        });
                    }
                });
            } else if (output.message && output.message.includes('data:image')) {
                images.push({
                    filename: 'image.png',
                    type: 'base64',
                    data: output.message.split(',')[1],
                    imageUrl: output.message
                });
            }

            if (images.length === 0) {
                this.errorMessage = '未在返回结果中找到图片';
                return;
            }

            this.results = images;
        },

        async cancelGeneration() {
            this.shouldStopPolling = true;

            if (this.currentJobId) {
                try {
                    await RunpodClient.cancel(this.currentJobId);
                } catch (err) {
                    // 忽略取消错误
                }
            }

            this.isGenerating = false;
            this.currentJobStatus = 'CANCELLED';
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

        // ========== 图片预览 ==========
        openImageModal(index) {
            this.selectedImageIndex = index;
            this.showImageModal = true;
        },

        closeImageModal() {
            this.showImageModal = false;
            this.selectedImageIndex = -1;
        },

        downloadImage(result) {
            if (result.type !== 'base64') return;

            const link = document.createElement('a');
            link.href = result.imageUrl;
            link.download = result.filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    }
});

app.component('image-upload', ImageUploadComponent);
app.mount('#app');
