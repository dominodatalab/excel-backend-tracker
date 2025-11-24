# model_registration.py
import os
import hashlib
import base64
import uuid
import time
import shutil
import logging
import tempfile
import json
import re
import pickle
from pathlib import Path
import joblib

import requests
import mlflow
import pandas as pd
from flask import jsonify
from mlflow.pyfunc import PythonModel
from mlflow.models.signature import infer_signature

from security_scan import run_semgrep_scan, summarize_semgrep, generate_html_report, generate_pdf_from_html, DEFAULT_SEMGREP_CONFIG

from endpoint_registration import register_endpoint


logger = logging.getLogger(__name__)

DOMINO_DOMAIN = os.environ.get("DOMINO_DOMAIN", "se-demo.domino.tech")
DOMINO_API_KEY = os.environ.get("DOMINO_USER_API_KEY", "")
POLICY_IDS_STRING = os.environ.get("POLICY_IDS", "42c9adf3-f233-470b-b186-107496d0eb05, ")
POLICY_IDS_LIST = [s.strip() for s in POLICY_IDS_STRING.split(',')]
DOMINO_PROJECT_ID = os.environ.get("DOMINO_PROJECT_ID", "")

print('POLICY_IDS_LIST', POLICY_IDS_LIST)

def domino_short_id(length: int = 8) -> str:
    """Generate a short ID based on Domino user and project."""
    def short_fallback():
        return base64.urlsafe_b64encode(uuid.uuid4().bytes).decode("utf-8").rstrip("=")[:length]

    user = os.environ.get("DOMINO_USER_NAME") or short_fallback()
    project = os.environ.get("DOMINO_PROJECT_ID") or short_fallback()
    combined = f"{user}/{project}"
    digest = hashlib.sha256(combined.encode()).digest()
    encoded = base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")
    return f"{user}_{encoded[:length]}"


EXPERIMENT_NAME = f"external_models_{domino_short_id(4)}"


def _create_pickle_pyfunc():
    """Factory function to create PicklePyFunc class without module dependencies."""
    import pickle
    import pandas as pd
    from mlflow.pyfunc import PythonModel
    
    class PicklePyFunc(PythonModel):
        """MLflow PyFunc wrapper for pickle models."""
        
        def load_context(self, context):
            with open(context.artifacts["model_pkl"], "rb") as f:
                self._model = pickle.load(f)
        
        def predict(self, context, model_input):
            X = model_input if isinstance(model_input, pd.DataFrame) else pd.DataFrame(model_input)
            if hasattr(self._model, "predict_proba"):
                return self._model.predict_proba(X)
            return self._model.predict(X)
    
    return PicklePyFunc()


def send_progress(request_id, step, message, progress_queues, progress=None, file_status=None):
    """Send progress update to the frontend."""
    if request_id in progress_queues:
        progress_queues[request_id].put({
            'step': step,
            'message': message,
            'progress': progress,
            'file_status': file_status
        })


def upload_file_to_project(project_id: str, local_path: str, remote_path: str) -> dict:
    """Upload a file to the head commit of the project repository."""
    domain = DOMINO_DOMAIN.removeprefix("https://").removeprefix("http://")
    url = f"https://{domain}/v4/projects/{project_id}/commits/head/files/{remote_path}"
    headers = {
        "accept": "application/json",
        "X-Domino-Api-Key": DOMINO_API_KEY
    }
    
    try:
        with open(local_path, 'rb') as f:
            files = {
                'upfile': (Path(local_path).name, f, 'application/octet-stream')
            }
            logger.info(f"Uploading {local_path} to project {project_id} at {remote_path}")
            response = requests.post(url, headers=headers, files=files, timeout=60)
            response.raise_for_status()
            result = response.json()
            logger.info(f"Successfully uploaded file: {result.get('path')} ({result.get('size')} bytes)")
            return result
    except requests.RequestException as e:
        logger.error(f"Failed to upload {local_path} to project: {e}")
        raise


def attach_report_to_bundle(bundle_id: str, filename: str, commit_key: str) -> dict:
    """Attach a report (HTML or PDF) to a governance bundle."""
    domain = DOMINO_DOMAIN.removeprefix("https://").removeprefix("http://")
    url = f"https://{domain}/api/governance/v1/bundles/{bundle_id}/attachments"
    headers = {
        "accept": "application/json",
        "Content-Type": "application/json",
        "X-Domino-Api-Key": DOMINO_API_KEY
    }
    payload = {
        "identifier": {
            "branch": "master",
            "commit": commit_key,
            "source": "DFS",
            "filename": filename
        },
        "type": "Report"
    }

    try:
        logger.info(f"Attaching report {filename} (commit={commit_key}) to bundle {bundle_id}")
        response = requests.post(url, headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        result = response.json()
        logger.info(f"Successfully attached report to bundle: {result.get('id')}")
        return result
    except requests.RequestException as e:
        logger.error(f"Failed to attach {filename} to bundle: {e}")
        raise


def save_uploaded_files(files, temp_dir):
    """Save uploaded files to temp directory maintaining structure."""
    saved_files = []
    for file in files:
        filepath = Path(temp_dir) / file.filename
        filepath.parent.mkdir(parents=True, exist_ok=True)
        file.save(str(filepath))
        filesize = filepath.stat().st_size
        saved_files.append({
            "path": str(filepath),
            "size_bytes": filesize,
            "size_mb": round(filesize / (1024 * 1024), 2)
        })
    return saved_files


def assist_governance_handler(request):
    """Use a Domino gateway LLM to suggest values for governance policy fields based on uploaded files.

    Expects: form fields `policyName`, `policyId`, optional `policy` (JSON string), and file uploads named `files`.
    Returns: JSON { status: 'success', suggestions: { '<label>': '<value>', ... } }
    """
    temp_dir = None
    try:
        policy_name = request.form.get('policyName')
        policy_id = request.form.get('policyId')
        policy_json = request.form.get('policy')

        files = request.files.getlist('files')
        temp_dir = tempfile.mkdtemp(prefix=f"assist_{policy_name}_")
        saved_files = save_uploaded_files(files, temp_dir)

        # Read uploaded file contents (text only) with size limits
        # For pickle files, attempt to disassemble and extract readable strings
        file_texts = {}
        for sf in saved_files:
            p = sf.get('path')
            name = Path(p).name
            content = None
            try:
                lower_name = name.lower()
                if lower_name.endswith(('.pkl', '.pickle')):
                    # Try to disassemble the pickle to get module/class names and other readable tokens
                    try:
                        import pickletools
                        import io as _io
                        with open(p, 'rb') as fh:
                            data = fh.read()
                        sio = _io.StringIO()
                        try:
                            pickletools.dis(data, out=sio)
                            disasm = sio.getvalue()
                            content = f"[PICKLE_DISASSEMBLY]\n{disasm[:20000]}"
                        except Exception:
                            # If disassembly fails, fall back to extracting printable ASCII sequences
                            strings = re.findall(rb'([ -~]{4,})', data)
                            combined = b'\n'.join(strings).decode('utf-8', errors='replace')
                            content = f"[PICKLE_STRINGS]\n{combined[:20000]}"
                    except Exception:
                        content = None
                else:
                    with open(p, 'r', encoding='utf-8', errors='replace') as fh:
                        content = fh.read(20000)  # limit to 20k chars per file
            except Exception:
                content = None
            file_texts[name] = content
            

        # Build prompt for LLM
        policy_part = policy_json if policy_json else f"Policy ID: {policy_id}"
        prompt = (
            "You are a governance assistant. Using ONLY the provided files and the policy information, "
            "suggest values for the policy's evidence variables. Return a single valid JSON object mapping exact "
            "field labels to suggested values. If a value cannot be determined from the files, return null for that label. "
            "Do not invent unrelated facts. Be concise.\n\n"
        )
        prompt += f"POLICY:\n{policy_part}\n\nFILES:\n"
        for name, content in file_texts.items():
            prompt += f"--- {name} ---\n"
            prompt += (content[:5000] if content else "[binary or unreadable]") + "\n\n"

        prompt += "\nReturn only JSON, e.g. {\"Model Description\": \"...\", \"Model Owner\": \"...\" }\n"

        # Call Domino gateway LLM via MLflow deployments
        from mlflow.deployments import get_deploy_client
        client = get_deploy_client(os.environ['DOMINO_MLFLOW_DEPLOYMENTS'])
        endpoint = os.environ.get('DOMINO_GATEWAY_LLM_ENDPOINT', 'fsi-chatbot')
        logger.info(f"Calling gateway LLM endpoint: {endpoint}")

        response = client.predict(endpoint=endpoint, inputs={"messages": [{"role": "user", "content": prompt}]})

        # Attempt to extract text from the response
        suggestions_raw = None
        if isinstance(response, dict):
            # common keys to check
            for k in ('predictions', 'outputs', 'result', 'text'):
                if k in response:
                    suggestions_raw = response[k]
                    break
            if suggestions_raw is None:
                suggestions_raw = json.dumps(response)
        else:
            suggestions_raw = str(response)

        # Convert to string if list or other
        if isinstance(suggestions_raw, (list, dict)):
            suggestions_str = json.dumps(suggestions_raw)
        else:
            suggestions_str = str(suggestions_raw)

        # Try to parse JSON out of the model response
        suggestions = {}
        try:
            suggestions = json.loads(suggestions_str)
        except Exception:
            # Try to extract a JSON object substring
            m = re.search(r"\{[\s\S]*\}", suggestions_str)
            if m:
                try:
                    suggestions = json.loads(m.group(0))
                except Exception:
                    suggestions = {}

        # Ensure keys are strings and values are simple types
        clean_suggestions = {}
        for k, v in (suggestions.items() if isinstance(suggestions, dict) else []):
            try:
                clean_suggestions[str(k).strip()] = v
            except Exception:
                continue

        return jsonify({"status": "success", "suggestions": clean_suggestions}), 200

    except Exception as e:
        logger.error(f"assist_governance_handler error: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        if temp_dir and Path(temp_dir).exists():
            try:
                shutil.rmtree(temp_dir)
            except Exception:
                pass


def update_model_description(model_name: str, description: str) -> dict:
    """Update model description via Domino API and return full response."""
    domain = DOMINO_DOMAIN.removeprefix("https://").removeprefix("http://")
    url = f"https://{domain}/api/registeredmodels/v1/{model_name}"
    headers = {
        "accept": "application/json",
        "Content-Type": "application/json",
        "X-Domino-Api-Key": DOMINO_API_KEY
    }
    payload = {
        "description": description,
        "discoverable": True
    }
    
    try:
        logger.info(f"Updating model description for {model_name}")
        response = requests.patch(url, json=payload, headers=headers, timeout=30)
        response.raise_for_status()
        model_data = response.json()
        logger.info(f"Successfully updated model description for {model_name}")
        return model_data
    except requests.RequestException as e:
        logger.error(f"Failed to update model description: {e}")
        raise


def normalize_label(label: str) -> str:
    """Transform label to match evidence variable names."""
    normalized = label.lower()
    normalized = re.sub(r'[^\w\s]', '', normalized)
    normalized = re.sub(r'\s+', '_', normalized)
    return normalized


def get_policy_details(policy_id: str) -> dict:
    """Get policy details including classification artifact map."""
    domain = DOMINO_DOMAIN.removeprefix("https://").removeprefix("http://")
    url = f"https://{domain}/api/governance/v1/policies/{policy_id}"
    headers = {
        "accept": "application/json",
        "X-Domino-Api-Key": DOMINO_API_KEY
    }
    
    try:
        logger.info(f"Getting policy details for policy ID: {policy_id}")
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        policy_data = response.json()
        logger.info(f"Successfully retrieved policy: {policy_data.get('name')}")
        
        tuples = []
        policy_id_from_response = policy_data.get("id")
        stages = policy_data.get("stages", [])
        
        for stage in stages:
            for evidence in stage.get("evidenceSet", []):
                evidence_id = evidence.get("id")
                for artifact in evidence.get("artifacts", []):
                    artifact_id = artifact.get("id")
                    label = artifact.get("details", {}).get("label")
                    input_type = artifact.get("details", {}).get("type")
                    if policy_id_from_response and evidence_id and artifact_id and label and input_type:
                        tuples.append((policy_id_from_response, evidence_id, artifact_id, label, input_type))
        
        unique_tuples = list(dict.fromkeys(tuples))
        
        return policy_data
    except requests.RequestException as e:
        logger.error(f"Failed to get policy details: {e}")
        raise


def create_bundle(model_name: str, model_version: int, policy_id: str) -> dict:
    """Create a bundle for the registered model."""
    domain = DOMINO_DOMAIN.removeprefix("https://").removeprefix("http://")
    url = f"https://{domain}/api/governance/v1/bundles"
    headers = {
        "accept": "application/json",
        "Content-Type": "application/json",
        "X-Domino-Api-Key": DOMINO_API_KEY
    }
    
    bundle_name = f"{model_name}_v{model_version}"
    payload = {
        "attachments": [
            {
                "identifier": {
                    "name": model_name,
                    "version": model_version
                },
                "type": "ModelVersion"
            }
        ],
        "name": bundle_name,
        "policyId": policy_id,
        "projectId": DOMINO_PROJECT_ID
    }
    
    try:
        logger.info(f"Creating bundle: {bundle_name}")
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        response.raise_for_status()
        bundle_data = response.json()
        logger.info(f"Successfully created bundle: {bundle_data.get('id')}")
        return bundle_data
    except requests.RequestException as e:
        logger.error(f"Failed to create bundle: {e}")
        raise


def submit_artifacts_to_policy(bundle_id: str, policy_id: str, matched_artifacts: list) -> dict:
    """Submit all artifacts to policy in a single batch call."""
    domain = DOMINO_DOMAIN.removeprefix("https://").removeprefix("http://")
    url = f"https://{domain}/api/governance/v1/rpc/submit-result-to-policy"
    headers = {
        "accept": "application/json",
        "Content-Type": "application/json",
        "X-Domino-Api-Key": DOMINO_API_KEY
    }
    
    evidence_groups = {}
    for artifact in matched_artifacts:
        if artifact['value'] is not None:
            evidence_id = artifact['evidence_id']
            if evidence_id not in evidence_groups:
                evidence_groups[evidence_id] = []
            evidence_groups[evidence_id].append(artifact)
    
    logger.info(f"Submitting {len(matched_artifacts)} artifacts across {len(evidence_groups)} evidence sets")
    
    results = []
    for evidence_id, artifacts in evidence_groups.items():
        content = {}
        for artifact in artifacts:
            artifact_id = artifact['artifact_id']
            value = artifact['value']
            
            if artifact['input_type'] == 'radio':
                if isinstance(value, bool):
                    content[artifact_id] = "Yes" if value else "No"
                else:
                    content[artifact_id] = str(value)
            else:
                content[artifact_id] = str(value)
        
        payload = {
            "bundleId": bundle_id,
            "content": content,
            "evidenceId": evidence_id,
            "policyId": policy_id
        }
        
        try:
            logger.info(f"Submitting evidence group {evidence_id} with {len(content)} artifacts")
            response = requests.post(url, json=payload, headers=headers, timeout=30)
            response.raise_for_status()
            result_data = response.json()
            results.append(result_data)
            logger.info(f"Successfully submitted evidence group {evidence_id}")
        except requests.RequestException as e:
            logger.error(f"Failed to submit evidence group {evidence_id}: {e}")
            raise
    
    return results[-1] if results else {}


def register_model_handler(request, progress_queues):
    """Handle model registration with security scanning and dynamic fields."""
    logger.info("=" * 80)
    logger.info("REGISTER EXTERNAL MODEL - Request Received")
    logger.info("=" * 80)
    
    temp_dir = None
    request_id = request.form.get("requestId", str(uuid.uuid4()))
    
    try:
        # Get policy information
        policy_name = request.form.get("policyName")
        policy_id = request.form.get("policyId")
        
        # Parse dynamic fields from JSON
        dynamic_fields_json = request.form.get("dynamicFields", "{}")
        dynamic_fields = json.loads(dynamic_fields_json)
        
        logger.info(f"Policy Name: {policy_name}")
        logger.info(f"Policy ID: {policy_id}")
        logger.info(f"Dynamic Fields: {dynamic_fields}")
        
        if not policy_id or not policy_name:
            return jsonify({"status": "error", "message": "Policy selection is required"}), 400

        send_progress(request_id, 'policy', 'Retrieving policy details...', progress_queues, progress=5)
        policy_data = get_policy_details(policy_id)
        
        files = request.files.getlist('files')
        temp_dir = tempfile.mkdtemp(prefix=f"external_model_{policy_name}_")
        logger.info(f"Created temp directory: {temp_dir}")
        
        send_progress(request_id, 'upload', 'Saving uploaded files...', progress_queues, progress=10)
        
        saved_files = save_uploaded_files(files, temp_dir)
        logger.info(f"Saved {len(saved_files)} files to temp directory")
        
        file_status = {}
        model_pkl = None
        signature_pkl = None
        
        # Extract commonly used fields from dynamic fields with proper normalization
        model_name = dynamic_fields.get('model_name', '')
        if not model_name:
            # Try different variations
            model_name = dynamic_fields.get('model-name', '')
        if not model_name:
            # Generate a default name if still empty
            model_name = f'model_{int(time.time())}'
            logger.warning(f"Model name not found in dynamic fields, using default: {model_name}")
        
        # Extract other fields with similar normalization
        model_description = dynamic_fields.get('model_description', dynamic_fields.get('model-description', ''))
        model_owner = dynamic_fields.get('model_owner', dynamic_fields.get('model-owner', ''))
        model_use_case = dynamic_fields.get('model_use_case', dynamic_fields.get('model-use-case', ''))
        model_usage_pattern = dynamic_fields.get('model_usage_pattern', dynamic_fields.get('model-usage-pattern', ''))
        model_environment_id = dynamic_fields.get('model_environment_id', dynamic_fields.get('model-environment-id', ''))
        model_execution_script = dynamic_fields.get('model_execution_script', dynamic_fields.get('model-execution-script', ''))
        
        logger.info(f"Extracted fields - Model Name: {model_name}, Owner: {model_owner}")

        list_the_file_names_and_sizes = ''
        for saved_file in saved_files:
            filepath = saved_file.get('path', '')
            filesize = saved_file.get('size_bytes', '')
            rel_path = str(Path(filepath).relative_to(temp_dir))
            file_status[rel_path] = 'uploaded'
            filename = Path(filepath).name
            
            list_the_file_names_and_sizes += f"{filename}  -  {filesize} Bytes\n"

            if filename == "model.pkl":
                model_pkl = filepath
            elif filename == "signature.pkl":
                signature_pkl = filepath

        if not model_pkl:
            return jsonify({"status": "error", "message": "model.pkl is required"}), 400

        send_progress(request_id, 'validate', 'Files uploaded successfully', progress_queues, progress=20, file_status=file_status)
        
        send_progress(request_id, 'security', 'Running security scan...', progress_queues, progress=25)
        logger.info(f"Starting security scan on {temp_dir}")
        semgrep_raw = run_semgrep_scan(temp_dir, config=DEFAULT_SEMGREP_CONFIG, timeout_sec=300)
        security_scan_summary = summarize_semgrep(semgrep_raw)
        logger.info(f"Security scan complete: {security_scan_summary['total_issues']} issues found")
        send_progress(request_id, 'security', f"Security scan complete: {security_scan_summary['total_issues']} issues found", progress_queues, progress=30)
        
        exp = mlflow.set_experiment(EXPERIMENT_NAME)
        experiment_id = exp.experiment_id
        logger.info(f"Using MLflow experiment: {EXPERIMENT_NAME}")
        
        send_progress(request_id, 'mlflow', 'Starting MLflow run...', progress_queues, progress=35)
        
        with mlflow.start_run(run_name=f"{model_name}_registration_{int(time.time())}") as run:
            run_id = run.info.run_id
            logger.info(f"Started MLflow run: {run_id}")
            
            send_progress(request_id, 'params', 'Logging parameters...', progress_queues, progress=45)
            
            # Log all dynamic fields as parameters
            for key, value in dynamic_fields.items():
                if value is not None and value != '':
                    # MLflow has a limit on param value length, truncate if needed
                    param_value = str(value)[:250] if len(str(value)) > 250 else str(value)
                    mlflow.log_param(key, param_value)
            
            # Add additional metadata
            mlflow.log_param("policy_name", policy_name)
            mlflow.log_param("policy_id", policy_id)
            mlflow.log_param("registration_time", time.time())
            mlflow.log_param("file_count", len(saved_files))
            
            mlflow.log_param("security_scan_total_issues", security_scan_summary['total_issues'])
            mlflow.log_param("security_scan_high", security_scan_summary['high'])
            mlflow.log_param("security_scan_medium", security_scan_summary['medium'])
            mlflow.log_param("security_scan_low", security_scan_summary['low'])
            
            send_progress(request_id, 'artifacts', 'Logging artifacts...', progress_queues, progress=55)
            for i, saved_file in enumerate(saved_files):
                filepath = saved_file["path"]
                rel_path = Path(filepath).relative_to(temp_dir)
                artifact_dir = str(rel_path.parent) if rel_path.parent != Path(".") else None
                mlflow.log_artifact(filepath, artifact_path=artifact_dir)
                logger.info(f"Logged artifact: {rel_path}")
                
                file_status[str(rel_path)] = 'logged'
                progress_val = 55 + (i + 1) / len(saved_files) * 10
                send_progress(request_id, 'artifacts', f'Logged {rel_path}', progress_queues, progress=progress_val, file_status=file_status)
            
            send_progress(request_id, 'security_log', 'Logging security scan results...', progress_queues, progress=66)
            
            security_report_json_path = Path(temp_dir) / "security_scan_report.json"
            with open(security_report_json_path, 'w') as f:
                json.dump(security_scan_summary, f, indent=2)
            mlflow.log_artifact(str(security_report_json_path), artifact_path="security")
            logger.info("Logged security scan JSON report")
            
            html_report = generate_html_report(
                security_scan_summary,
                model_name=model_name,
                scan_metadata={
                    'model_owner': model_owner,
                    'model_use_case': model_use_case
                }
            )
            security_report_html_path = Path(temp_dir) / "security_scan_report.html"
            with open(security_report_html_path, 'w', encoding='utf-8') as f:
                f.write(html_report)
            mlflow.log_artifact(str(security_report_html_path), artifact_path="security")
            logger.info("Logged security scan HTML report")
            
            try:
                security_report_pdf_path = Path(temp_dir) / "security_scan_report.pdf"
                generate_pdf_from_html(str(security_report_html_path), str(security_report_pdf_path))
                mlflow.log_artifact(str(security_report_pdf_path), artifact_path="security")
                logger.info("Logged security scan PDF report")
            except Exception as e:
                logger.warning(f"Failed to generate PDF report (non-fatal): {e}")

            send_progress(request_id, 'model', 'Registering model...', progress_queues, progress=70)
            
            # Validate model_name before registration
            if not model_name or model_name.strip() == '':
                raise ValueError("Model name cannot be empty. Please provide a Model Name in the form.")
            
            logger.info(f"Registering model with name: {model_name}")

            if signature_pkl:
                signature = joblib.load(signature_pkl)
            else:
                with open(model_pkl, "rb") as f:
                    loaded_model = pickle.load(f)
                
                # Create sample data for signature inference
                if hasattr(loaded_model, 'n_features_in_'):
                    n_features = loaded_model.n_features_in_
                    X_sample = pd.DataFrame([[0.0] * n_features])
                else:
                    X_sample = pd.DataFrame([[0.0, 0.0, 0.0]])
                
                # Infer signature
                if hasattr(loaded_model, "predict_proba"):
                    y_sample = loaded_model.predict_proba(X_sample)
                else:
                    y_sample = loaded_model.predict(X_sample)
                signature = infer_signature(X_sample, y_sample)
                            
            # Log model using PicklePyFunc wrapper
            model_info = mlflow.pyfunc.log_model(
                artifact_path="model",
                python_model=_create_pickle_pyfunc(),
                artifacts={"model_pkl": str(model_pkl)},
                pip_requirements=[],
                signature=signature,
                registered_model_name=model_name
            )
            
            logger.info(f"Successfully logged model to MLflow: {model_info.model_uri}")
        
        send_progress(request_id, 'api', 'Updating model description...', progress_queues, progress=75)
        model_data = update_model_description(model_name, model_description)
        model_version = model_data.get("latestVersion", 1)
        
        send_progress(request_id, 'bundle', 'Creating governance bundle...', progress_queues, progress=80)
        bundle_data = create_bundle(model_name, model_version, policy_id)
        bundle_name = bundle_data.get("name", "")
        bundle_id = bundle_data.get("id", "")
        project_owner = bundle_data.get("projectOwner", "")
        project_name = bundle_data.get("projectName", "")
        project_id = bundle_data.get("projectId", "")
        stage = bundle_data.get("stage", "").lower().replace(" ", "-")
        html_remote_path = f"security_scans/{bundle_name}_security_report.html"
        pdf_remote_path = f"security_scans/{bundle_name}_security_report.pdf"
        
        try:
            html_upload_result = upload_file_to_project(DOMINO_PROJECT_ID, str(security_report_html_path), html_remote_path)
            pdf_upload_result = upload_file_to_project(DOMINO_PROJECT_ID, str(security_report_pdf_path), pdf_remote_path)
    
            logger.info("Security reports successfully uploaded to Domino project repository.")
    
            html_commit = html_upload_result.get("key")
            pdf_commit = pdf_upload_result.get("key")
            html_filename = html_upload_result.get("path")
            pdf_filename = pdf_upload_result.get("path")
    
            html_attachment = attach_report_to_bundle(bundle_id, html_filename, html_commit)
            pdf_attachment = attach_report_to_bundle(bundle_id, pdf_filename, pdf_commit)
    
            logger.info(f"Attached reports to bundle {bundle_id}: HTML({html_attachment.get('id')}), PDF({pdf_attachment.get('id')})")
    
        except Exception as e:
            logger.error(f"Failed to upload or attach security reports to bundle: {e}", exc_info=True)

        domain = DOMINO_DOMAIN.removeprefix("https://").removeprefix("http://")
        experiment_url = f"https://{domain}/experiments/{project_owner}/{project_name}/{experiment_id}"
        experiment_run_url = f"https://{domain}/experiments/{project_owner}/{project_name}/{experiment_id}/{run_id}"
        model_artifacts_url = f"https://{domain}/experiments/{project_owner}/{project_name}/{experiment_id}/{run_id}?isdir=false&path=model%2FMLmodel&tab=Outputs"
        model_card_url = f"https://{domain}/u/{project_owner}/{project_name}/model-registry/{model_name}/model-card?version={model_version}"
        bundle_url = f"https://{domain}/u/{project_owner}/{project_name}/governance/bundle/{bundle_id}/policy/{policy_id}/evidence/stage/{stage}"
        security_scan_url = f"https://{domain}/u/{project_owner}/{project_name}/view-file/{html_remote_path}"
        
        # Add file list to dynamic fields if not already present
        dynamic_fields['list_the_file_names_and_sizes'] = list_the_file_names_and_sizes
        dynamic_fields['were_all_files_uploaded'] = True
        
        # Add some default values if not provided
        if 'model_version' not in dynamic_fields:
            dynamic_fields['model_version'] = model_version
        if 'executive_summary' not in dynamic_fields:
            dynamic_fields['executive_summary'] = f"Executive Summary: {model_description}"
        if 'does_this_model_use_thirdparty_components_or_services' not in dynamic_fields:
            dynamic_fields['does_this_model_use_thirdparty_components_or_services'] = True
        if 'ai_classification_level' not in dynamic_fields:
            dynamic_fields['ai_classification_level'] = 2
                
        stages = policy_data.get("stages", [])
        
        matched_artifacts = []
        seen_keys = set()
        
        for stage in stages:
            for evidence in stage.get("evidenceSet", []):
                evidence_id = evidence.get("id")
                for artifact in evidence.get("artifacts", []):
                    artifact_id = artifact.get("id")
                    label = artifact.get("details", {}).get("label")
                    input_type = artifact.get("details", {}).get("type")
                    
                    if policy_id and evidence_id and artifact_id and label and input_type:
                        unique_key = (policy_id, evidence_id, artifact_id, label, input_type)
                        
                        if unique_key not in seen_keys:
                            seen_keys.add(unique_key)
                            # Try to find matching value in dynamic fields
                            # Normalize the label to match how frontend sends it
                            normalized_key = label.lower().replace(' ', '_').replace('?', '').replace(',', '').replace("'", '')
                            normalized_key_hyphen = normalized_key.replace('_', '-')
                            value = None
                            
                            # Try different key variations
                            for field_key, field_value in dynamic_fields.items():
                                # Check exact match or hyphen/underscore variations
                                if (field_key == normalized_key or 
                                    field_key == normalized_key_hyphen or
                                    field_key.replace('-', '_') == normalized_key or
                                    field_key.replace('_', '-') == normalized_key_hyphen):
                                    value = field_value
                                    break
                            
                            matched_artifacts.append({
                                'bundle_id': bundle_id,
                                'policy_id': policy_id,
                                'evidence_id': evidence_id,
                                'artifact_id': artifact_id,
                                'label': label,
                                'input_type': input_type,
                                'value': value
                            })
        
        print("\nMatched Policy Artifacts with Evidence Variables:")
        for artifact in matched_artifacts:
            if artifact['value'] is not None:
                print(f"  {artifact['label']}: {artifact['value']}")

        send_progress(request_id, 'evidence', 'Submitting evidence to policy...', progress_queues, progress=90)
        policy_submission_result = submit_artifacts_to_policy(bundle_id, policy_id, matched_artifacts)
        logger.info(f"Successfully submitted {len([a for a in matched_artifacts if a['value'] is not None])} artifacts to policy")

        send_progress(request_id, 'endpoint', 'Registering model endpoint...', progress_queues, progress=95)
        try:
            
            endpoint_data = register_endpoint(bundle_id, bundle_name, model_name, model_version)
            endpoint_id = endpoint_data.get("id", "")
        except Exception as e:
            print('no endpoint created')
            endpoint_id = 'no-endpoint-created'
        endpoint_url = f"https://{domain}/models/{endpoint_id}/overview"

        logger.info(f"Successfully registered endpoint: {endpoint_id}")

        send_progress(request_id, 'complete', 'Registration complete!', progress_queues, progress=100)
        send_progress(request_id, 'done', '', progress_queues, progress=100)
        
        if temp_dir and Path(temp_dir).exists():
            shutil.rmtree(temp_dir)
            logger.info(f"Cleaned up temp directory: {temp_dir}")
        
        logger.info("=" * 80)
        
        response_data = {
            "status": "success",
            "message": "Model registered and bundle created successfully",
            "data": {
                "model_name": model_name,
                "model_version": model_version,
                "run_id": run_id,
                "experiment_name": EXPERIMENT_NAME,
                "file_count": len(saved_files),
                "bundle_id": bundle_id,
                "bundle_name": bundle_data.get("name"),
                "endpoint_id": endpoint_id,
                "endpoint_url": endpoint_url,
                "experiment_url": experiment_url,
                "experiment_run_url": experiment_run_url,
                "model_artifacts_url": model_artifacts_url,
                "model_card_url": model_card_url,
                "bundle_url": bundle_url,
                "security_scan_url": security_scan_url,
                "policy_name": policy_name,
                "policy_id": policy_id,
                "project_id": DOMINO_PROJECT_ID,
                "project_name": project_name,
                "artifacts_submitted": len([a for a in matched_artifacts if a['value'] is not None])
            }
        }
        
        if security_scan_summary:
            response_data["data"]["security_scan"] = {
                "total_issues": security_scan_summary['total_issues'],
                "high": security_scan_summary['high'],
                "medium": security_scan_summary['medium'],
                "low": security_scan_summary['low'],
            }
        
        return jsonify(response_data), 200
        
    except Exception as e:
        logger.error(f"Error registering model: {e}", exc_info=True)
        send_progress(request_id, 'error', f'Error: {str(e)}', progress_queues, progress=0)
        send_progress(request_id, 'done', '', progress_queues, progress=0)
        
        if temp_dir and Path(temp_dir).exists():
            shutil.rmtree(temp_dir)
        
        return jsonify({
            "status": "error",
            "message": f"Failed to register model: {str(e)}"
        }), 500