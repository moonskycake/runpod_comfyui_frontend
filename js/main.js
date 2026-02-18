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
                     id="image-upload-container">
                    <input type="file" id="image-upload-input" ref="fileInput" @change="handleChooseFile"
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
            // Workflow 相关
            workflowJson: '',
            workflowError: '',
            
            // 输入图片
            inputImages: [],
            
            // 生成状态
            isGenerating: false,
            currentJobId: '',
            currentJobStatus: '',
            jobStats: {
                delayTime: null,
                executionTime: null
            },
            errorMessage: '',
            shouldStopPolling: false,
            
            // 结果
            results: [],
            
            // 设置相关
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
            connectionStatus: '未配置',
            isConfigValid: false,
            
            // 图片预览
            showImageModal: false,
            selectedImageIndex: -1
        };
    },
    
    computed: {
        isConfigured() {
            return this.isConfigValid;
        },
        
        canGenerate() {
            return this.isConfigured && 
                   this.workflowJson.trim() && 
                   !this.workflowError;
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
        
        selectedImage() {
            if (this.selectedImageIndex < 0 || this.selectedImageIndex >= this.results.length) {
                return null;
            }
            return this.results[this.selectedImageIndex];
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

        // 先设置配置有效性，再更新连接状态
        this.isConfigValid = Settings.isConfigured();
        this.updateConnectionStatus();
    },
    
    watch: {
        workflowJson(val) {
            this.validateWorkflowJson();
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
        }
    },
    
    methods: {
        // 验证 Workflow JSON
        validateWorkflowJson() {
            this.workflowError = '';
            if (!this.workflowJson.trim()) return;
            
            try {
                const parsed = JSON.parse(this.workflowJson);
                
                // 检查是否是有效的 ComfyUI workflow
                if (typeof parsed !== 'object' || parsed === null) {
                    this.workflowError = 'JSON 必须是对象类型';
                    return;
                }
                
                // 如果外层有 input.workflow，提取内部
                if (parsed.input && parsed.input.workflow) {
                    // 这是完整的 RunPod 请求格式，提取 workflow
                    this.workflowJson = JSON.stringify(parsed.input.workflow, null, 2);
                }
                
            } catch (e) {
                this.workflowError = 'JSON 格式错误: ' + e.message;
            }
        },
        
        // 上传 Workflow JSON
        handleWorkflowUpload(event) {
            const file = event.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    // 先尝试解析验证
                    JSON.parse(e.target.result);
                    this.workflowJson = e.target.result;
                } catch (err) {
                    alert('JSON 文件格式错误: ' + err.message);
                }
            };
            reader.readAsText(file);
            
            // 清空文件输入，允许重复选择同一文件
            event.target.value = '';
        },
        
        // 加载示例 workflow
        async loadExampleWorkflow() {
            try {
                const response = await fetch('./ComfyUI_temp_pabtb_00004_ (2).json');
                if (!response.ok) throw new Error('加载失败');
                const data = await response.json();
                this.workflowJson = JSON.stringify(data, null, 2);
            } catch (err) {
                alert('加载示例失败: ' + err.message);
            }
        },
        
        // 清空 workflow
        clearWorkflow() {
            this.workflowJson = '';
            this.workflowError = '';
        },
        
        // 添加输入图片
        addInputImage() {
            this.inputImages.push({
                name: `input_${this.inputImages.length + 1}.png`,
                image: '',
                sizeWarning: ''
            });
        },
        
        // 移除输入图片
        removeInputImage(index) {
            this.inputImages.splice(index, 1);
        },
        
        // 生成
        async generate() {
            if (!this.canGenerate) return;
            
            this.isGenerating = true;
            this.errorMessage = '';
            this.currentJobId = '';
            this.currentJobStatus = '';
            this.jobStats = { delayTime: null, executionTime: null };
            this.shouldStopPolling = false;
            
            // 构建 payload
            let workflow;
            try {
                workflow = JSON.parse(this.workflowJson);
            } catch (err) {
                this.errorMessage = 'Workflow JSON 解析失败';
                this.isGenerating = false;
                return;
            }
            
            const payload = {
                input: {
                    workflow: workflow
                }
            };
            
            // 添加输入图片
            const validImages = this.inputImages
                .filter(img => img.image && img.name)
                .map(img => ({
                    name: img.name,
                    image: img.image
                }));
            
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
                    // 同步模式
                    this.currentJobStatus = '执行中...';
                    const result = await RunpodClient.runSync(payload, 300000); // 最多等待 5 分钟
                    
                    if (result.success) {
                        this.handleCompletedResult(result.data);
                    } else {
                        this.errorMessage = result.message;
                    }
                } else {
                    // 异步模式
                    const runResult = await RunpodClient.run(payload);
                    
                    if (!runResult.success) {
                        this.errorMessage = runResult.message;
                        this.isGenerating = false;
                        return;
                    }
                    
                    this.currentJobId = runResult.data.id;
                    this.currentJobStatus = runResult.data.status;
                    
                    // 轮询状态
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
                        this.errorMessage = '已取消';
                    } else {
                        this.errorMessage = pollResult.message;
                    }
                }
            } catch (err) {
                this.errorMessage = '生成失败: ' + err.message;
            } finally {
                this.isGenerating = false;
                this.currentJobStatus = '';
            }
        },
        
        // 处理完成的结果
        handleCompletedResult(data) {
            if (data.executionTime !== undefined) {
                this.jobStats.executionTime = data.executionTime;
            }
            
            const output = data.output;
            if (!output) {
                this.errorMessage = '返回结果中没有 output 字段';
                return;
            }
            
            // 解析图片结果
            const images = [];
            
            // v5.0.0+ 格式: output.images[]
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
            }
            // 旧格式兼容: output.message
            else if (output.message) {
                // 尝试解析 base64 图片
                if (output.message.includes('data:image')) {
                    images.push({
                        filename: 'image.png',
                        type: 'base64',
                        data: output.message.split(',')[1],
                        imageUrl: output.message
                    });
                } else {
                    this.errorMessage = '检测到旧格式输出，但无法解析图片';
                }
            }
            
            if (images.length === 0) {
                this.errorMessage = '未在返回结果中找到图片';
                console.log('完整输出:', output);
                return;
            }
            
            this.results = images;
        },
        
        // 取消生成
        async cancelGeneration() {
            this.shouldStopPolling = true;
            
            if (this.currentJobId) {
                try {
                    await RunpodClient.cancel(this.currentJobId);
                } catch (err) {
                    console.error('取消失败:', err);
                }
            }
            
            this.isGenerating = false;
            this.currentJobStatus = '已取消';
        },
        
        // 设置相关
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
            
            // 更新客户端配置
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
            
            // 临时设置配置进行测试
            RunpodClient.setConfig({
                endpointId: this.settingsForm.endpointId,
                apiKey: this.settingsForm.apiKey
            });
            
            const result = await RunpodClient.health();
            this.connectionTestResult = result;
            
            this.testingConnection = false;
        },
        
        updateConnectionStatus() {
            if (!this.isConfigured) {
                this.connectionStatus = '未配置';
            } else {
                this.connectionStatus = '已配置';
            }
        },
        
        // 图片预览
        openImageModal(index) {
            this.selectedImageIndex = index;
            this.showImageModal = true;
        },
        
        closeImageModal() {
            this.showImageModal = false;
            this.selectedImageIndex = -1;
        },
        
        // 下载图片
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
