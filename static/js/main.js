// static/js/main.js
const DOMINO_API_BASE = window.location.origin + window.location.pathname.replace(/\/$/, '');
const ORIGINAL_API_BASE = window.DOMINO?.API_BASE || '';
const API_KEY = window.DOMINO?.API_KEY || null;
// Inline sparkles/star SVG (Heroicons-style) as a data URI for reliable badges
const AI_ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3l1.5 3 3.5.5-2.5 2 0.6 3.4L12 11l-3.1 1.9.6-3.4-2.5-2L10.5 6 12 3z" fill="#F59E0B" stroke="none"/>
    <path d="M5 20l1 2 2 .3-1.4 1.1L7 25l-1 1-0.6-1.6L4 24l1-1z" fill="#FBBF24" stroke="none"/>
    <path d="M18 13l.8 1.6 1.8.3-1.2 1 .3 1.8L18 18l-1.7 1 .3-1.8-1.2-1L16.2 14 18 13z" fill="#FBBF24" stroke="none"/>
</svg>
`;
const AI_ICON_URL = 'data:image/svg+xml;utf8,' + encodeURIComponent(AI_ICON_SVG);

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

    // After rendering dynamic fields, attach listeners to clear AI badges when user edits fields
    // Text inputs and textareas: on input, if value differs from ai original, remove badge
    const textFields = container.querySelectorAll('input[type="text"], textarea');
    textFields.forEach(f => {
        f.addEventListener('input', (ev) => {
            const el = ev.target;
            const orig = el.getAttribute('data-ai-original');
                    if (orig !== null) {
                const cur = (el.value || '').toString();
                if (cur !== orig) {
                    // remove badge if present (look in input-wrapper first, then form-group)
                    const wrapper = el.closest('.input-wrapper');
                    const group = el.closest('.form-group');
                    const badge = wrapper ? wrapper.querySelector('.ai-badge') : (group ? group.querySelector('.ai-badge') : null);
                    if (badge) {
                        badge.remove();
                        if (group) group.classList.remove('has-ai-badge');
                    }
                    el.removeAttribute('data-ai-original');
                    el.classList.remove('auto-filled');
                }
            }
        });
    });

    // Radio inputs: on change, clear ai badges in the group if user changes selection
    const radioInputs = container.querySelectorAll('input[type="radio"][data-label]');
    radioInputs.forEach(r => {
        r.addEventListener('change', (ev) => {
            const lbl = r.getAttribute('data-label');
            // find any ai-badge for this label and remove if selected value differs from ai suggested
            const group = container.querySelectorAll(`input[type="radio"][data-label="${CSS.escape(lbl)}"]`);
                group.forEach(g => {
                const parent = g.closest('.form-group') || g.closest('label') || g.parentElement;
                const badge = parent ? parent.querySelector('.ai-badge') : null;
                if (badge) {
                    // if the currently checked value does not match data-ai-original, remove
                    const orig = badge.getAttribute('data-ai-original');
                    if (orig !== null) {
                        const checked = Array.from(group).find(x => x.checked);
                        if (!checked || String(checked.value) !== orig) {
                            badge.remove();
                            if (parent && parent.classList) parent.classList.remove('has-ai-badge');
                        }
                    }
                }
            });
        });
    });
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
            const name = file.name;
            return name.toLowerCase().endsWith('.docx');
        });

    if (files.length === 0 && event.target.files.length > 0) {
        showErrors(['Please upload only .docx files']);
        return;
    }

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
        errors.push('Please upload a .docx file');
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
    button.innerHTML = '<span class="spinner"></span> Submitting...';

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
    button.innerHTML = 'Submit Governance Data';

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
                <h3>✓ Governance Data Submitted Successfully</h3>
                <p>Your governance data has been submitted.</p>
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
                ${result.data.bundle_url ? `
                    <a href="${result.data.bundle_url}" target="_blank" rel="noopener noreferrer" class="link-button">
                        <i class="icon fas fa-clipboard-list"></i>
                        <span>Governance Bundle</span>
                        <i class="external-icon fas fa-external-link-alt"></i>
                    </a>
                ` : ''}
            </div>
        </div>
    ` : '';

    const infoHtml = result.data ? `
        <div class="model-info">
            <h4>Submission Results:</h4>
            <div class="info-grid">
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
            <h3>✓ Governance Submission Complete</h3>
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
    // remove any AI badges and group markers
    try {
        document.querySelectorAll('.ai-badge').forEach(b => b.remove());
        document.querySelectorAll('.form-group.has-ai-badge').forEach(g => g.classList.remove('has-ai-badge'));
    } catch (e) {}
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
        showErrors(['Please upload a .docx file first']);
        return;
    }

    showErrors([]);

    const assistButton = document.getElementById('assist-governance-button');
    assistButton.disabled = true;
    assistButton.classList.add('btn-ai-loading');

    // Prepare dynamic fields: text inputs/textarea show animated ellipsis; radios are disabled
    const dynamicContainer = document.getElementById('dynamic-fields');
    const animFields = dynamicContainer ? Array.from(dynamicContainer.querySelectorAll('input[type="text"], textarea')) : [];
    const radioInputs = dynamicContainer ? Array.from(dynamicContainer.querySelectorAll('input[type="radio"]')) : [];
    const ellipsisStates = ['.', '..', '...'];
    let ellIdx = 0;
    const savedValues = new Map();
    const savedRadioDisabled = new Map();
    // Put text fields into readonly and start animation
    animFields.forEach(f => {
        savedValues.set(f, f.value);
        f.setAttribute('data-ai-orig-value', f.value || '');
        try { f.readOnly = true; } catch (e) {}
        f.classList.add('ai-thinking');
        f.value = ellipsisStates[ellIdx];
    });
    // Disable radios, add tooltip on their labels, and mark container for dimming
    radioInputs.forEach(r => {
        savedRadioDisabled.set(r, r.disabled);
        try { r.disabled = true; } catch (e) {}
        try {
            const lbl = r.closest('label') || (() => {
                // try to find a label referencing this input
                if (r.id) return document.querySelector(`label[for="${r.id}"]`);
                return null;
            })();
            if (lbl) {
                lbl.setAttribute('data-ai-tooltip', 'Autofill in progress');
                lbl.setAttribute('title', 'Autofill in progress');
                lbl.classList.add('ai-tooltip-target');
            }
        } catch (e) {}
    });
    if (dynamicContainer) dynamicContainer.classList.add('dynamic-ai-disabled');

    const ellipsisInterval = setInterval(() => {
        ellIdx = (ellIdx + 1) % ellipsisStates.length;
        animFields.forEach(f => {
            try { f.value = ellipsisStates[ellIdx]; } catch (e) {}
        });
    }, 450);

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
        // Extract usable suggestions from nested gateway response
        const suggestions = extractSuggestionsFromAssistResponse(data);

        // Stop animation and restore editability before applying suggestions
        clearInterval(ellipsisInterval);
        // restore original values (so fields are empty if they were empty before autofill)
        animFields.forEach(f => {
            if (savedValues.has(f)) {
                try { f.value = savedValues.get(f) || ''; } catch (e) {}
            }
        });
        animFields.forEach(f => {
            f.classList.remove('ai-thinking');
            try { f.readOnly = false; } catch (e) {}
        });
        radioInputs.forEach(r => {
            try { r.disabled = savedRadioDisabled.has(r) ? savedRadioDisabled.get(r) : false; } catch (e) {}
            try {
                const lbl = r.closest('label') || (r.id ? document.querySelector(`label[for="${r.id}"]`) : null);
                if (lbl) {
                    lbl.removeAttribute('data-ai-tooltip');
                    lbl.removeAttribute('title');
                    lbl.classList.remove('ai-tooltip-target');
                }
            } catch (e) {}
        });
        if (dynamicContainer) dynamicContainer.classList.remove('dynamic-ai-disabled');

        if (suggestions && Object.keys(suggestions).length > 0) {
            populateSuggestedFields(suggestions);
            // Do NOT show registration success here — only show when user actually submits registration
        } else {
            // restore previous values if assistant returned nothing useful
            animFields.forEach(f => {
                if (savedValues.has(f)) f.value = savedValues.get(f) || '';
            });
            showErrors(['No suggestions returned from assistant']);
        }

    } catch (err) {
        console.error('Assist error', err);
        // stop animation and restore values + radios
        clearInterval(ellipsisInterval);
        animFields.forEach(f => {
            try { f.readOnly = false; } catch (e) {}
            if (savedValues.has(f)) {
                try { f.value = savedValues.get(f) || ''; } catch (e) {}
            }
            f.classList.remove('ai-thinking');
        });
        radioInputs.forEach(r => {
            try { r.disabled = savedRadioDisabled.has(r) ? savedRadioDisabled.get(r) : false; } catch (e) {}
            try {
                const lbl = r.closest('label') || (r.id ? document.querySelector(`label[for="${r.id}"]`) : null);
                if (lbl) {
                    lbl.removeAttribute('data-ai-tooltip');
                    lbl.removeAttribute('title');
                    lbl.classList.remove('ai-tooltip-target');
                }
            } catch (e) {}
        });
        if (dynamicContainer) dynamicContainer.classList.remove('dynamic-ai-disabled');
        showErrors([`Assist failed: ${err.message}`]);
    } finally {
        assistButton.disabled = false;
        assistButton.classList.remove('btn-ai-loading');
    }
}

// Helper function to add AI badge to an input field
function addAiBadgeToField(field, value) {
    // Wrap field in input-wrapper if not already wrapped
    let wrapper = field.parentElement;
    if (!wrapper || !wrapper.classList.contains('input-wrapper')) {
        wrapper = document.createElement('div');
        wrapper.className = 'input-wrapper';
        field.parentNode.insertBefore(wrapper, field);
        wrapper.appendChild(field);
    }

    // Add badge if not already present
    if (!wrapper.querySelector('.ai-badge')) {
        const badge = document.createElement('span');
        badge.className = 'ai-badge';
        badge.setAttribute('data-ai-original', String(value));
        badge.innerHTML = `<img src="${AI_ICON_URL}" alt="ai"/>`;
        wrapper.appendChild(badge);

        // Mark the form-group for padding
        const formGroup = wrapper.closest('.form-group');
        if (formGroup) {
            formGroup.classList.add('has-ai-badge');
        }
    }
}

// Populate suggested fields returned by the backend
function populateSuggestedFields(suggestions) {
    if (!suggestions) return;

    // Batch DOM lookups for performance: map data-label -> elements
    const dynamicContainer = document.getElementById('dynamic-fields');
    const allLabeled = Array.from(dynamicContainer.querySelectorAll('[data-label]'));
    const labelMap = new Map();
    const normMap = new Map();
    const normalize = (s) => {
        if (!s) return '';
        return String(s).toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim();
    };
    allLabeled.forEach(el => {
        const lbl = el.getAttribute('data-label');
        if (!labelMap.has(lbl)) labelMap.set(lbl, []);
        labelMap.get(lbl).push(el);

        const n = normalize(lbl);
        if (n) {
            if (!normMap.has(n)) normMap.set(n, []);
            normMap.get(n).push(el);
            // also store underscore and hyphen variants
            const u = n.replace(/\s+/g, '_');
            const h = n.replace(/\s+/g, '-');
            if (!normMap.has(u)) normMap.set(u, []);
            normMap.get(u).push(el);
            if (!normMap.has(h)) normMap.set(h, []);
            normMap.get(h).push(el);
        }
    });

    // Also build a radio lookup by data-label
    const allRadios = Array.from(dynamicContainer.querySelectorAll('input[type="radio"][data-label]'));
    const radioMap = new Map();
    allRadios.forEach(r => {
        const lbl = r.getAttribute('data-label');
        if (!radioMap.has(lbl)) radioMap.set(lbl, []);
        radioMap.get(lbl).push(r);
    });

    // Apply suggestions
    const entries = Object.entries(suggestions);
    // Use requestAnimationFrame to allow UI to remain responsive on large updates
    window.requestAnimationFrame(() => {
        entries.forEach(([label, value]) => {
            if (value === null || value === undefined) return;

            const fields = labelMap.get(label) || [];
            if (fields.length > 0) {
                fields.forEach(field => {
                    const tag = field.tagName.toLowerCase();
                    // only auto-fill if field is empty to avoid overwriting user input
                    const isEmpty = (field.value || '').toString().trim() === '';
                    if ((tag === 'textarea' || (tag === 'input' && field.type === 'text')) && isEmpty) {
                        field.value = value;
                        field.setAttribute('data-ai-original', String(value));
                        field.dispatchEvent(new Event('input'));
                        field.classList.add('auto-filled');
                        // Add AI badge using helper function
                        try {
                            addAiBadgeToField(field, value);
                        } catch (e) {
                            // ignore
                        }
                        setTimeout(() => field.classList.remove('auto-filled'), 2000);
                    }
                });
            } else {
                // try normalized lookup
                const nlabel = normalize(label);
                const nfields = normMap.get(nlabel) || normMap.get(nlabel.replace(/\s+/g, '_')) || normMap.get(nlabel.replace(/\s+/g, '-')) || [];
                if (nfields.length > 0) {
                    nfields.forEach(field => {
                        const tag = field.tagName.toLowerCase();
                        const isEmpty = (field.value || '').toString().trim() === '';
                        if ((tag === 'textarea' || (tag === 'input' && field.type === 'text')) && isEmpty) {
                            field.value = value;
                            field.setAttribute('data-ai-original', String(value));
                            field.dispatchEvent(new Event('input'));
                            field.classList.add('auto-filled');
                            try {
                                addAiBadgeToField(field, value);
                            } catch (e) {}
                            setTimeout(() => field.classList.remove('auto-filled'), 2000);
                        }
                    });
                }
            }

            // Handle radio groups: select the option that matches the suggested value
                if (radioMap.has(label)) {
                const radios = radioMap.get(label);
                // Only set radio if none in the group is already checked
                const anyChecked = radios.some(r => r.checked);
                if (!anyChecked) {
                    radios.forEach(r => {
                        try {
                            if (String(r.value).toLowerCase() === String(value).toLowerCase()) {
                                r.checked = true;
                                r.dispatchEvent(new Event('change'));
                                // highlight the label containing this radio and add badge to form group
                                const parentLabel = r.closest('label') || r.parentElement;
                                if (parentLabel) {
                                    parentLabel.classList.add('auto-filled');
                                    try {
                                        // For radio buttons, add badge to the form-group level
                                        const formGroup = parentLabel.closest('.form-group');
                                        if (formGroup && !formGroup.querySelector('.ai-badge')) {
                                            const badge = document.createElement('span');
                                            badge.className = 'ai-badge';
                                            badge.style.position = 'absolute';
                                            badge.style.top = '6px';
                                            badge.style.right = '6px';
                                            badge.setAttribute('data-ai-original', String(value));
                                            badge.innerHTML = `<img src="${AI_ICON_URL}" alt="ai"/>`;
                                            formGroup.style.position = 'relative';
                                            formGroup.appendChild(badge);
                                            formGroup.classList.add('has-ai-badge');
                                        }
                                    } catch (e) {}
                                    setTimeout(() => parentLabel.classList.remove('auto-filled'), 2000);
                                }
                            }
                        } catch (e) {
                            // ignore
                        }
                    });
                }
            }

            // Fallback: try to find element by a sanitized id
            if ((!fields || fields.length === 0) && !radioMap.has(label)) {
                const idSafe = labelToFieldId(label);
                const fallback = document.getElementById(idSafe);
                if (fallback) {
                    fallback.value = value;
                    fallback.dispatchEvent(new Event('input'));
                }
            }
        });
    });
}


// Extract suggestions from the assist API response, handling nested structures and code fences
function extractSuggestionsFromAssistResponse(data) {
    if (!data) return {};

    // If the backend already returned a suggestions object mapping labels -> values, use it
    if (data.suggestions && typeof data.suggestions === 'object' && !Array.isArray(data.suggestions)) {
        // Detect if it's the full gateway response (with choices)
        if (data.suggestions.choices && Array.isArray(data.suggestions.choices)) {
            // fall through to parsing choices
        } else {
            return data.suggestions;
        }
    }

    // Handle gateway-like response where suggestions contain choices
    let contentStr = '';
    try {
        if (data.suggestions && data.suggestions.choices && Array.isArray(data.suggestions.choices) && data.suggestions.choices.length > 0) {
            const choice = data.suggestions.choices[0];
            if (choice.message && choice.message.content) {
                contentStr = choice.message.content;
            } else if (choice.text) {
                contentStr = choice.text;
            } else if (choice.output) {
                contentStr = JSON.stringify(choice.output);
            }
        } else if (data.choices && Array.isArray(data.choices) && data.choices.length > 0) {
            const choice = data.choices[0];
            if (choice.message && choice.message.content) contentStr = choice.message.content;
            else if (choice.text) contentStr = choice.text;
            else contentStr = JSON.stringify(choice);
        } else if (data.suggestions && typeof data.suggestions === 'string') {
            contentStr = data.suggestions;
        } else if (typeof data === 'string') {
            contentStr = data;
        } else if (data.suggestions && typeof data.suggestions === 'object') {
            // maybe already contains mapping
            return data.suggestions;
        }
    } catch (e) {
        console.error('Error extracting content from assist response', e);
        return {};
    }

    if (!contentStr) return {};

    // Strip markdown code fences if present
    const fenceMatch = contentStr.match(/```(?:json)?\n([\s\S]*?)\n```/i);
    let jsonText = fenceMatch ? fenceMatch[1] : contentStr;

    // Try to locate the first JSON object in the text
    const objMatch = jsonText.match(/\{[\s\S]*\}/);
    if (objMatch) {
        jsonText = objMatch[0];
    }

    try {
        const parsed = JSON.parse(jsonText);
        // If parsed contains nested choices structure, drill down
        if (parsed.suggestions && typeof parsed.suggestions === 'object') return parsed.suggestions;
        return parsed;
    } catch (e) {
        // Not JSON parseable
        console.warn('Assist response JSON parse failed:', e.message);
        return {};
    }
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
                    <div class="form-column-left card">
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
                            <label for="model-upload">Upload .docx File <span class="required">*</span></label>
                            <input type="file" id="model-upload" accept=".docx" multiple required style="display: none;">
                            <button type="button" class="btn btn-upload" onclick="document.getElementById('model-upload').click()">Choose .docx File(s)</button>
                            <p class="help-text">Upload one or more .docx files containing your governance information</p>
                        </div>
                        
                        <div id="uploaded-files-display" class="files-display">
                            <p class="no-files">No files uploaded yet</p>
                        </div>
                        
                        <div class="form-actions">
                            <button type="button" class="btn btn-ai" id="assist-governance-button" title="Autofill Fields">
                                <img src="${AI_ICON_URL}" alt="ai" class="ai-inline-icon" style="width:16px;height:16px;vertical-align:middle;margin-right:6px;">Autofill Fields
                            </button>
                            <button type="submit" class="btn btn-primary">Submit Governance Data</button>
                            <button type="button" class="btn btn-secondary" onclick="resetForm()">Reset</button>
                        </div>

                        <div id="success-message" style="display: none;"></div>
                    </div>

                    <div class="form-column-middle card">
                        <div id="dynamic-fields">
                            <p>Please select a governance policy to see the required fields</p>
                        </div>
                    </div>
                </div>
            </form>
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