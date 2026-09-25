import hashlib
import re


def normalize_text(text: str) -> str:
    if not text:
        return ""
    
    # Strip UUIDs
    text = re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<UUID>', text, flags=re.IGNORECASE)
    # Strip Hex IDs (e.g. 0xabcd, long hex strings)
    text = re.sub(r'0x[0-9a-f]+', '<HEX>', text, flags=re.IGNORECASE)
    text = re.sub(r'\b[0-9a-f]{7,}\b', '<HEX>', text, flags=re.IGNORECASE)
    # Strip IPs
    text = re.sub(r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b', '<IP>', text)
    # Strip pod suffixes (-7d9f8c-x2k1)
    text = re.sub(r'-[0-9a-f]{5,10}-[0-9a-z]{4,5}\b', '<POD_SUFFIX>', text)
    # Strip numbers above 3 digits
    text = re.sub(r'\b\d{4,}\b', '<NUM>', text)
    
    # Lowercase and collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip().lower()
    return text

def compute_signature(source: str, service: str, environment: str, labels: dict[str, str], title: str, description: str) -> str:
    alertname = labels.get("alertname", "")
    error_class = labels.get("error_class", "")
    top_stack_frame = labels.get("top_stack_frame", "")
    
    normalized_title = normalize_text(title)
    
    # Extract parts
    parts = [
        source,
        service or "",
        environment,
        alertname,
        error_class,
        top_stack_frame,
        normalized_title
    ]
    
    # Sort label keys to ensure determinism, exclude the ones already used
    used_labels = {"alertname", "error_class", "top_stack_frame"}
    sorted_labels = sorted([(k, v) for k, v in labels.items() if k not in used_labels])
    for k, v in sorted_labels:
        parts.append(f"{k}={normalize_text(str(v))}")
        
    canonical = " | ".join(p for p in parts if p)
    return canonical

def get_signature_hash(canonical: str) -> str:
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()
