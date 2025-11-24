// static/js/main.js
const DOMINO_API_BASE = window.location.origin + window.location.pathname.replace(/\/$/, '');
const ORIGINAL_API_BASE = window.DOMINO?.API_BASE || '';
const API_KEY = window.DOMINO?.API_KEY || null;

// Hardcoded policy IDs
const POLICY_IDS = {
    'External Model Upload': '42c9adf3-f233-470b-b186-107496d0eb05',
    'AI Use Case Intake': '4a8da911-bb6b-480d-a5a9-9918550c741e'  // Using same ID for now, replace with actual second policy ID
};

// Global state
let appState = {
    uploadedFiles: [],
    formData: {},
    policies: {},
    selectedPolicy: null
};

// Helper function to format file size
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Helper function to make proxy API calls
async function proxyFetch(apiPath, options = {}) {
    const [basePath, queryString] = apiPath.split('?');
    const targetParam = `target=${encodeURIComponent(ORIGINAL_API_BASE)}`;
    const finalQuery = queryString ? `${queryString}&${targetParam}` : targetParam;
    const url = `${DOMINO_API_BASE}/proxy/${basePath.replace(/^\//, '')}?${finalQuery}`;
    
    const defaultHeaders = {
        'X-Domino-Api-Key': API_KEY,
        'accept': 'application/json'
    };
    
    return fetch(url, {
        ...options,
        headers: {
            ...defaultHeaders,
            ...options.headers
        }
    });
}

// Fetch policy details
async function fetchPolicyDetails(policyId) {
    try {
        const response = await proxyFetch(`/api/governance/v1/policies/${policyId}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch policy: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Error fetching policy ${policyId}:`, error);
        return null;
    }
}

// Load all policies on startup
async function loadPolicies() {
    console.log('Loading policies...');
    for (const [name, id] of Object.entries(POLICY_IDS)) {
        const policy = await fetchPolicyDetails(id);
        if (policy) {
            appState.policies[name] = policy;
            console.log(`Loaded policy: ${name}`, policy);
        }
    }
}

// Convert label to field ID
function labelToFieldId(label) {
    return label.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, '-');
}

// Generate dynamic form fields based on policy
function generateDynamicFields(policy) {
    const container = document.getElementById('dynamic-fields');
    if (!policy || !policy.stages) {
        container.innerHTML = '<p>No policy fields available</p>';
        return;
    }
    
    let fieldsHtml = '';
    
    // Iterate through all stages and evidence sets
    policy.stages.forEach(stage => {
        if (stage.evidenceSet && stage.evidenceSet.length > 0) {
            fieldsHtml += `<h4>${stage.name}</h4>`;
            
            stage.evidenceSet.forEach(evidence => {
                if (evidence.artifacts && evidence.artifacts.length > 0) {
                    fieldsHtml += `<div class="evidence-section">`;
                    fieldsHtml += `<h5>${evidence.name}</h5>`;
                    if (evidence.description) {
                        fieldsHtml += `<p class="evidence-description">${evidence.description}</p>`;
                    }
                    
                    evidence.artifacts.forEach(artifact => {
                        const label = artifact.details.label;
                        const type = artifact.details.type;
                        const fieldId = `field-${artifact.id}`;
                        const required = artifact.required;
                        
                        fieldsHtml += '<div class="form-group">';
                        fieldsHtml += `<label for="${fieldId}">${label}${required ? ' <span class="required">*</span>' : ''}</label>`;
                        
                        switch (type) {
                            case 'textinput':
                                fieldsHtml += `<input type="text" id="${fieldId}" name="${fieldId}" data-label="${label}" data-artifact-id="${artifact.id}" ${required ? 'required' : ''}>`;
                                break;
                            case 'textarea':
                                fieldsHtml += `<textarea id="${fieldId}" name="${fieldId}" rows="4" data-label="${label}" data-artifact-id="${artifact.id}" ${required ? 'required' : ''}></textarea>`;
                                break;
                            case 'radio':
                                if (artifact.details.options) {
                                    fieldsHtml += '<div class="radio-group">';
                                    artifact.details.options.forEach((option, index) => {
                                        fieldsHtml += `
                                            <label class="radio-label">
                                                <input type="radio" name="${fieldId}" value="${option}" data-label="${label}" data-artifact-id="${artifact.id}" ${index === 0 ? 'checked' : ''}>
                                                ${option}
                                            </label>
                                        `;
                                    });
                                    fieldsHtml += '</div>';
                                }
                                break;
                        }
                        
                        fieldsHtml += '</div>';
                    });
                    
                    fieldsHtml += '</div>';
                }
            });
        }
    });
    
    container.innerHTML = fieldsHtml;
}

// Handle policy selection change
function handlePolicyChange(event) {
    const selectedPolicyName = event.target.value;
    appState.selectedPolicy = selectedPolicyName;
    
    const policy = appState.policies[selectedPolicyName];
    if (policy) {
        generateDynamicFields(policy);
    }
}

// Handle file upload
function handleFileUpload(event) {
    const files = Array.from(event.target.files)
        .filter(file => {
            const name = file.webkitRelativePath || file.name;
            return !name.split('/').some(part => part.startsWith('.'));
        });
    
    appState.uploadedFiles = files;
    displayUploadedFiles();
}

// Display uploaded files
function displayUploadedFiles() {
    const container = document.getElementById('uploaded-files-display');
    
    if (appState.uploadedFiles.length === 0) {
        container.innerHTML = '<p class="no-files">No files uploaded yet</p>';
        return;
    }
    
    const filesHtml = appState.uploadedFiles.map(file => {
        const filename = file.webkitRelativePath || file.name;
        return `
            <div class="file-item" data-filename="${filename}">
                <div class="file-info">
                    <span class="file-name">${filename}</span>
                    <span class="file-size">${formatFileSize(file.size)}</span>
                    <span class="file-status-check"></span>
                </div>
            </div>
        `;
    }).join('');
    
    container.innerHTML = `
        <div class="files-list">
            <h4>Uploaded Files (${appState.uploadedFiles.length})</h4>
            ${filesHtml}
        </div>
    `;
}

// Collect all dynamic field values
function collectDynamicFields() {
    const dynamicData = {};
    const dynamicContainer = document.getElementById('dynamic-fields');
    
    // Collect all inputs and textareas
    dynamicContainer.querySelectorAll('input[type="text"], textarea').forEach(field => {
        const label = field.getAttribute('data-label');
        if (label) {
            const key = label.toLowerCase()
                .replace(/[^\w\s]/g, '')
                .replace(/\s+/g, '_');  // Use underscore for consistency with backend
            dynamicData[key] = field.value.trim();
        }
    });
    
    // Collect radio buttons
    dynamicContainer.querySelectorAll('.radio-group').forEach(group => {
        const checkedRadio = group.querySelector('input[type="radio"]:checked');
        if (checkedRadio) {
            const label = checkedRadio.getAttribute('data-label');
            if (label) {
                const key = label.toLowerCase()
                    .replace(/[^\w\s]/g, '')
                    .replace(/\s+/g, '_');  // Use underscore for consistency with backend
                const value = checkedRadio.value;
                // Convert Yes/No to boolean for backend
                if (value === 'Yes' || value === 'No') {
                    dynamicData[key] = value === 'Yes';
                } else {
                    dynamicData[key] = value;
                }
            }
        }
    });
    
    return dynamicData;
}

// Validate form
function validateForm() {
    const errors = [];
    
    if (!appState.selectedPolicy) {
        errors.push('Please select a policy');
    }
    
    if (appState.uploadedFiles.length === 0) {
        errors.push('Please upload model files');
        document.getElementById('model-upload').classList.add('error');
    } else {
        document.getElementById('model-upload').classList.remove('error');
    }
    
    // Validate required dynamic fields
    const dynamicContainer = document.getElementById('dynamic-fields');
    dynamicContainer.querySelectorAll('[required]').forEach(field => {
        if (!field.value.trim()) {
            const label = field.closest('.form-group').querySelector('label').textContent.replace(' *', '');
            errors.push(`${label} is required`);
            field.classList.add('error');
        } else {
            field.classList.remove('error');
        }
    });
    
    return errors;
}

// Show error messages
function showErrors(errors) {
    const errorContainer = document.getElementById('error-messages');
    
    if (errors.length === 0) {
        errorContainer.innerHTML = '';
        errorContainer.style.display = 'none';
        return;
    }
    
    errorContainer.innerHTML = `
        <div class="error-box">
            <h4>Please fix the following errors:</h4>
            <ul>
                ${errors.map(error => `<li>${error}</li>`).join('')}
            </ul>
        </div>
    `;
    errorContainer.style.display = 'block';
}

// Show loading state
function showLoading(button) {
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Registering Model...';
    
    // Create progress container under the button
    const progressContainer = document.createElement('div');
    progressContainer.id = 'progress-container';
    progressContainer.className = 'progress-container';
    
    progressContainer.innerHTML = `
        <div class="progress-bar-container">
            <div class="progress-bar" style="width: 0%"></div>
        </div>
        <div class="progress-message">Initializing...</div>
    `;
    
    // Insert after the form actions
    const formActions = document.querySelector('.form-actions');
    formActions.after(progressContainer);
}

// Update progress
function updateProgress(data) {
    const progressBar = document.querySelector('.progress-bar');
    const progressMessage = document.querySelector('.progress-message');
    
    if (progressBar && data.progress !== undefined) {
        progressBar.style.width = `${data.progress}%`;
    }
    
    if (progressMessage && data.message) {
        progressMessage.textContent = data.message;
    }
    
    // Update file statuses with checkmarks
    if (data.file_status) {
        Object.entries(data.file_status).forEach(([filename, status]) => {
            const fileItem = document.querySelector(`.file-item[data-filename="${filename}"]`);
            if (fileItem) {
                const statusCheck = fileItem.querySelector('.file-status-check');
                
                if (status === 'uploaded' || status === 'logged') {
                    statusCheck.innerHTML = '✓';
                    statusCheck.classList.add('checked');
                }
            }
        });
    }
}

// Hide loading state
function hideLoading(button) {
    button.disabled = false;
    button.innerHTML = 'Register AI Use Case with Domino';
    
    const progressContainer = document.getElementById('progress-container');
    if (progressContainer) {
        setTimeout(() => {
            progressContainer.style.opacity = '0';
            setTimeout(() => progressContainer.remove(), 300);
        }, 2000);
    }
}

// Show success message
function showSuccess(result) {
    const successContainer = document.getElementById('success-message');
    
    if (!result) {
        successContainer.innerHTML = `
            <div class="success-box">
                <h3>✓ Model Registered Successfully</h3>
                <p>Your model has been registered with Domino.</p>
            </div>
        `;
        successContainer.style.display = 'block';
        return;
    }
    
    const isSuccess = result.status === 'success';
    const statusColor = isSuccess ? '#10b981' : '#ef4444';
    const statusText = result.status || 'unknown';
    
    const linksHtml = result.data ? `
        <div class="model-links">
            <h4>Quick Links:</h4>
            <div class="link-buttons-grid">
                ${result.data.security_scan_url ? `
                    <a href="${result.data.security_scan_url}" target="_blank" rel="noopener noreferrer" class="link-button">
                        <i class="icon fas fa-shield-halved"></i>
                        <span>Security Scan</span>
                        <i class="external-icon fas fa-external-link-alt"></i>
                    </a>
                ` : ''}
                ${result.data.bundle_url ? `
                    <a href="${result.data.bundle_url}" target="_blank" rel="noopener noreferrer" class="link-button">
                        <i class="icon fas fa-clipboard-list"></i>
                        <span>Intake Bundle</span>
                        <i class="external-icon fas fa-external-link-alt"></i>
                    </a>
                ` : ''}
                ${result.data.endpoint_url ? `
                    <a href="${result.data.endpoint_url}" target="_blank" rel="noopener noreferrer" class="link-button">
                        <i class="icon fas fa-plug"></i>
                        <span>REST Endpoint</span>
                        <i class="external-icon fas fa-external-link-alt"></i>
                    </a>
                ` : ''}
                ${result.data.model_card_url ? `
                    <a href="${result.data.model_card_url}" target="_blank" rel="noopener noreferrer" class="link-button">
                        <i class="icon fas fa-id-card"></i>
                        <span>Model Card</span>
                        <i class="external-icon fas fa-external-link-alt"></i>
                    </a>
                ` : ''}
                ${result.data.model_artifacts_url ? `
                    <a href="${result.data.model_artifacts_url}" target="_blank" rel="noopener noreferrer" class="link-button">
                        <i class="icon fas fa-cube"></i>
                        <span>Model Artifacts</span>
                        <i class="external-icon fas fa-external-link-alt"></i>
                    </a>
                ` : ''}
                ${result.data.experiment_run_url ? `
                    <a href="${result.data.experiment_run_url}" target="_blank" rel="noopener noreferrer" class="link-button">
                        <i class="icon fas fa-play-circle"></i>
                        <span>Experiment Run</span>
                        <i class="external-icon fas fa-external-link-alt"></i>
                    </a>
                ` : ''}
                ${result.data.experiment_url ? `
                    <a href="${result.data.experiment_url}" target="_blank" rel="noopener noreferrer" class="link-button">
                        <i class="icon fas fa-flask"></i>
                        <span>Experiment</span>
                        <i class="external-icon fas fa-external-link-alt"></i>
                    </a>
                ` : ''}
            </div>
        </div>
    ` : '';
    
    const infoHtml = result.data ? `
        <div class="model-info">
            <h4>Registration Results:</h4>
            <div class="info-grid">
                ${result.data.model_name ? `
                    <div class="info-item">
                        <span class="info-label">Model Name:</span>
                        <span class="info-value">${result.data.model_name}</span>
                    </div>
                ` : ''}
                ${result.data.model_version !== undefined ? `
                    <div class="info-item">
                        <span class="info-label">Model Version:</span>
                        <span class="info-value">${result.data.model_version}</span>
                    </div>
                ` : ''}
                ${result.data.bundle_name ? `
                    <div class="info-item">
                        <span class="info-label">Bundle Name:</span>
                        <span class="info-value">${result.data.bundle_name}</span>
                    </div>
                ` : ''}
                ${result.data.bundle_id ? `
                    <div class="info-item">
                        <span class="info-label">Bundle ID:</span>
                        <span class="info-value">${result.data.bundle_id}</span>
                    </div>
                ` : ''}
                ${result.data.experiment_name ? `
                    <div class="info-item">
                        <span class="info-label">Experiment Name:</span>
                        <span class="info-value">${result.data.experiment_name}</span>
                    </div>
                ` : ''}
                ${result.data.run_id ? `
                    <div class="info-item">
                        <span class="info-label">Experiment Run ID:</span>
                        <span class="info-value">${result.data.run_id}</span>
                    </div>
                ` : ''}
                ${result.data.policy_name ? `
                    <div class="info-item">
                        <span class="info-label">Policy Name:</span>
                        <span class="info-value">${result.data.policy_name}</span>
                    </div>
                ` : ''}
                ${result.data.policy_id ? `
                    <div class="info-item">
                        <span class="info-label">Policy ID:</span>
                        <span class="info-value">${result.data.policy_id}</span>
                    </div>
                ` : ''}
                ${result.data.project_name ? `
                    <div class="info-item">
                        <span class="info-label">Project Name:</span>
                        <span class="info-value">${result.data.project_name}</span>
                    </div>
                ` : ''}
                ${result.data.project_id ? `
                    <div class="info-item">
                        <span class="info-label">Project ID:</span>
                        <span class="info-value">${result.data.project_id}</span>
                    </div>
                ` : ''}
            </div>
        </div>
    ` : '';
    
    successContainer.innerHTML = `
        <div class="success-box">
            <h3>✓ Model Registration Complete</h3>
            <div class="status-line">
                <span class="status-label">Status:</span>
                <span class="status-value" style="color: ${statusColor}; font-weight: bold;">${statusText}</span>
            </div>
            ${linksHtml}
            ${infoHtml}
        </div>
    `;
    successContainer.style.display = 'block';
}

// Reset form
function resetForm() {
    document.getElementById('model-upload-form').reset();
    appState.uploadedFiles = [];
    displayUploadedFiles();
    showErrors([]);
    document.getElementById('success-message').innerHTML = '';
    document.getElementById('success-message').style.display = 'none';
    
    // Reset to first policy
    const policySelector = document.getElementById('policy-selector');
    if (policySelector) {
        policySelector.selectedIndex = 0;
        handlePolicyChange({ target: policySelector });
    }
    
    const progressContainer = document.getElementById('progress-container');
    if (progressContainer) {
        progressContainer.remove();
    }
}

// Handle form submission with SSE progress
async function handleSubmit(event) {
    event.preventDefault();
    
    const errors = validateForm();
    if (errors.length > 0) {
        showErrors(errors);
        return;
    }
    
    showErrors([]);
    document.getElementById('success-message').innerHTML = '';
    document.getElementById('success-message').style.display = 'none';
    
    const submitButton = event.target.querySelector('button[type="submit"]');
    showLoading(submitButton);
    
    // Generate unique request ID
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Set up SSE for progress updates
    const basePath = window.location.pathname.replace(/\/$/, '');
    const eventSource = new EventSource(`${basePath}/register-progress/${requestId}`);
    
    eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        updateProgress(data);
        
        if (data.step === 'done') {
            eventSource.close();
        }
    };
    
    eventSource.onerror = () => {
        eventSource.close();
    };
    
    try {
        // Collect form data
        const formData = new FormData();
        
        formData.append('requestId', requestId);
        formData.append('policyName', appState.selectedPolicy);
        formData.append('policyId', POLICY_IDS[appState.selectedPolicy]);
        
        // Collect and append all dynamic fields
        const dynamicFields = collectDynamicFields();
        formData.append('dynamicFields', JSON.stringify(dynamicFields));
        
        // Append files
        appState.uploadedFiles.forEach(file => {
            formData.append('files', file, file.webkitRelativePath || file.name);
        });
        
        // Make API call
        const response = await fetch(`${basePath}/register-external-model`, {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`Registration failed: ${response.status} ${response.statusText}`);
        }
        
        const result = await response.json();
        console.log('Registration successful:', result);
        
        showSuccess(result);
        
    } catch (error) {
        console.error('Registration error:', error);
        showErrors([`Failed to register AI use case: ${error.message}`]);
    } finally {
        hideLoading(submitButton);
    }
}

// Handle Assist with Governance action
async function handleAssistGovernance(event) {
    // Basic validation
    if (!appState.selectedPolicy) {
        showErrors(['Please select a policy before requesting assistance']);
        return;
    }

    if (appState.uploadedFiles.length === 0) {
        showErrors(['Please upload model files first']);
        return;
    }

    showErrors([]);

    const assistButton = document.getElementById('assist-governance-button');
    assistButton.disabled = true;
    const originalText = assistButton.innerHTML;
    assistButton.innerHTML = '<span class="spinner"></span> Assisting...';

    try {
        const formData = new FormData();
        formData.append('policyName', appState.selectedPolicy);
        formData.append('policyId', POLICY_IDS[appState.selectedPolicy]);

        // Attach the full policy JSON if available
        const policyObj = appState.policies[appState.selectedPolicy] || null;
        if (policyObj) {
            formData.append('policy', JSON.stringify(policyObj));
        }

        // Append uploaded files (preserve relative path if present)
        appState.uploadedFiles.forEach(file => {
            const name = file.webkitRelativePath || file.name;
            formData.append('files', file, name);
        });

        const basePath = window.location.pathname.replace(/\/$/, '');
        const resp = await fetch(`${basePath}/assist-governance`, {
            method: 'POST',
            body: formData
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(errText || 'Assist request failed');
        }

        const data = await resp.json();
        if (data && data.suggestions) {
            populateSuggestedFields(data.suggestions);
            const successObj = { status: 'success', data: { message: 'Assistance applied' } };
            showSuccess(successObj);
        } else {
            showErrors(['No suggestions returned from assistant']);
        }

    } catch (err) {
        console.error('Assist error', err);
        showErrors([`Assist failed: ${err.message}`]);
    } finally {
        assistButton.disabled = false;
        assistButton.innerHTML = originalText;
    }
}

// Populate suggested fields returned by the backend
function populateSuggestedFields(suggestions) {
    if (!suggestions) return;

    Object.entries(suggestions).forEach(([label, value]) => {
        if (value === null || value === undefined) return;

        // Find inputs or textareas that have data-label equal to the label
        const dynamicContainer = document.getElementById('dynamic-fields');
        const selector = `[data-label]`;
        const fields = Array.from(dynamicContainer.querySelectorAll(selector)).filter(el => el.getAttribute('data-label') === label);

        if (fields.length > 0) {
            fields.forEach(field => {
                if (field.tagName.toLowerCase() === 'textarea' || field.type === 'text') {
                    field.value = value;
                    field.dispatchEvent(new Event('input'));
                }
            });
        } else {
            // If we couldn't find a field, try to match by label-like id
            const idSafe = labelToFieldId(label);
            const fallback = document.getElementById(idSafe);
            if (fallback) {
                fallback.value = value;
                fallback.dispatchEvent(new Event('input'));
            }
        }
    });
}

// Initialize form
function initializeForm() {
    const container = document.querySelector('.container');
    
    container.innerHTML = `
        <h1 class="welcome-title">Register AI Use Case</h1>
        
        <div id="error-messages"></div>
        
        <div class="form-layout">
            <form id="model-upload-form" class="model-form">
                <div class="form-columns">
                    <div class="form-column-left">
                        <div class="form-group">
                            <label for="policy-selector">Select Governance Policy <span class="required">*</span></label>
                            <select id="policy-selector" name="policySelector" required>
                                <option value="">-- Select a Policy --</option>
                                ${Object.keys(POLICY_IDS).map(name => 
                                    `<option value="${name}">${name}</option>`
                                ).join('')}
                            </select>
                        </div>
                        
                        <div class="form-group">
                            <label for="model-upload">Upload Model Folder <span class="required">*</span></label>
                            <input type="file" id="model-upload" webkitdirectory directory multiple required style="display: none;">
                            <button type="button" class="btn btn-upload" onclick="document.getElementById('model-upload').click()">Choose Files</button>
                            <p class="help-text">Upload a folder containing model.pkl, requirements.txt, metadata.json, and inference.py</p>
                        </div>
                        
                        <div id="uploaded-files-display" class="files-display">
                            <p class="no-files">No files uploaded yet</p>
                        </div>
                        
                        <div class="form-actions">
                            <button type="submit" class="btn btn-primary">Register AI Use Case with Domino</button>
                            <button type="button" class="btn btn-ai" id="assist-governance-button" title="Assist with Governance">
                                <i class="fas fa-robot"></i>&nbsp;Assist with Governance
                            </button>
                            <button type="button" class="btn btn-secondary" onclick="resetForm()">Reset</button>
                        </div>
                    </div>
                    
                    <div class="form-column-middle">
                        <div id="dynamic-fields">
                            <p>Please select a governance policy to see the required fields</p>
                        </div>
                    </div>
                </div>
            </form>
            
            <div class="results-column">
                <div id="success-message" style="display: none;"></div>
            </div>
        </div>
    `;
    
    // Attach event listeners
    document.getElementById('model-upload').addEventListener('change', handleFileUpload);
    document.getElementById('model-upload-form').addEventListener('submit', handleSubmit);
    document.getElementById('policy-selector').addEventListener('change', handlePolicyChange);
    const assistBtn = document.getElementById('assist-governance-button');
    if (assistBtn) {
        assistBtn.addEventListener('click', handleAssistGovernance);
    }
    
    // Load policies and set default
    loadPolicies().then(() => {
        console.log('Policies loaded successfully');
    });
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', initializeForm);

console.log('Model upload form initialized');