from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, request
from urllib.parse import parse_qs, quote, urlparse

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from PIL import Image, ImageOps

try:
    from volcengine.imagex.v2.imagex_service import ImagexService
except ImportError:  # pragma: no cover - optional dependency during local bootstrap
    ImagexService = None


ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("HOST", "0.0.0.0").strip() or "0.0.0.0"
PORT = int(os.environ.get("PORT", "4173"))
OPENAI_URL = "https://api.openai.com/v1/responses"
DOUBAO_IMAGE_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
DEFAULT_DOUBAO_IMAGE_MODEL = "doubao-seedream-5-0-260128"
DEFAULT_VEIMAGEX_REGION = "cn-north-1"
DEFAULT_VEIMAGEX_MODEL_ACTION = "Img2ImgXLSft"
DEFAULT_VEIMAGEX_MODEL_VERSION = "2022-08-31"
DEFAULT_VEIMAGEX_REQ_KEY = "i2i_xl_sft"
SECRETS_FILE = ROOT / "secrets.local.json"
WECHAT_PAY_BASE_URL = "https://api.mch.weixin.qq.com"
WECHAT_PAY_CREATE_URL = f"{WECHAT_PAY_BASE_URL}/v3/pay/transactions/h5"
WECHAT_PAY_AMOUNT_FEN = 99
REFERENCE_UPLOAD_PREFIX = "baby-reference"
LANCZOS = Image.Resampling.LANCZOS


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self) -> None:
        if self.path == "/api/analyze":
            self.handle_analyze()
            return

        if self.path == "/api/generate-image":
            self.handle_generate_image()
            return

        if self.path == "/api/payment/create":
            self.handle_payment_create()
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint.")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/config-status":
            self.handle_config_status()
            return

        if parsed.path == "/api/payment/status":
            self.handle_payment_status(parsed.query)
            return

        super().do_GET()

    def handle_config_status(self) -> None:
        image_ready = is_image_service_configured()
        analysis_ready = bool(load_openai_api_key())
        payment_ready = is_wechat_pay_configured()

        if payment_ready:
            pay_message = "支付功能已配置。"
        else:
            pay_message = "支付功能未配置。"

        if image_ready and analysis_ready:
            message = f"图片服务已配置，分析服务也已配置。{pay_message}"
        elif image_ready:
            message = f"图片服务已配置；分析会优先走本地娱乐预测。{pay_message}"
        else:
            message = f"图片服务未配置。{pay_message}"

        self._send_json(
            HTTPStatus.OK,
            {
                "configured": image_ready,
                "imageConfigured": image_ready,
                "analysisConfigured": analysis_ready,
                "paymentConfigured": payment_ready,
                "message": message,
            },
        )

    def handle_analyze(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return

        upstream_request = payload.get("request")
        api_key = load_openai_api_key()

        if not api_key:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": {"message": "后端未配置 OpenAI API Key。"}},
            )
            return

        if not isinstance(upstream_request, dict):
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": {"message": "缺少可转发的请求参数。"}},
            )
            return

        status, parsed = self._forward_json_request(
            url=OPENAI_URL,
            api_key=api_key,
            payload=upstream_request,
        )
        self._send_json(status, parsed)

    def handle_generate_image(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return

        status, parsed = generate_image_from_payload(payload, self._forward_json_request)
        self._send_json(status, parsed)

    def handle_payment_create(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return

        if not is_wechat_pay_configured():
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": {"message": "微信支付尚未配置，请先补齐商户参数。"}},
            )
            return

        action = str(payload.get("action") or "analyze").strip().lower()
        if action not in {"analyze", "regenerate"}:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": {"message": "不支持的支付动作。"}},
            )
            return

        try:
            client_ip = self._infer_client_ip()
            order_no = build_order_no(action)
            body = build_wechat_h5_order_body(order_no=order_no, client_ip=client_ip)
            status, parsed = forward_wechat_request(
                method="POST",
                path="/v3/pay/transactions/h5",
                payload=body,
            )

            if status != HTTPStatus.OK:
                message = extract_provider_error(parsed, default_message="微信支付下单失败。")
                self._send_json(status, {"error": {"message": message}})
                return

            pay_url = str(parsed.get("h5_url") or parsed.get("mweb_url") or "").strip()
            if not pay_url:
                self._send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": {"message": "微信支付已返回成功，但没有拿到支付链接。"}},
                )
                return

            redirect_url = load_wechat_pay_return_url()
            if redirect_url:
                separator = "&" if "?" in pay_url else "?"
                pay_url = f"{pay_url}{separator}redirect_url={quote(redirect_url, safe='')}"

            self._send_json(
                HTTPStatus.OK,
                {
                    "orderNo": order_no,
                    "action": action,
                    "amount": WECHAT_PAY_AMOUNT_FEN,
                    "payUrl": pay_url,
                },
            )
        except Exception as exc:  # noqa: BLE001
            print("WeChat pay create exception:", repr(exc), flush=True)
            traceback.print_exc()
            self._send_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": {"message": f"支付订单创建失败：{exc}"}},
            )

    def handle_payment_status(self, query: str) -> None:
        if not is_wechat_pay_configured():
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": {"message": "微信支付尚未配置，请先补齐商户参数。"}},
            )
            return

        params = parse_qs(query, keep_blank_values=False)
        order_no = str((params.get("out_trade_no") or [""])[0]).strip()
        if not order_no:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": {"message": "缺少 out_trade_no。"}},
            )
            return

        path = f"/v3/pay/transactions/out-trade-no/{quote(order_no, safe='')}?mchid={quote(load_wechat_pay_mchid(), safe='')}"

        try:
            status, parsed = forward_wechat_request(method="GET", path=path, payload=None)
            if status != HTTPStatus.OK:
                message = extract_provider_error(parsed, default_message="支付状态查询失败。")
                self._send_json(status, {"error": {"message": message}})
                return

            trade_state = str(parsed.get("trade_state") or "").strip().upper()
            self._send_json(
                HTTPStatus.OK,
                {
                    "orderNo": order_no,
                    "paid": trade_state == "SUCCESS",
                    "tradeState": trade_state or "UNKNOWN",
                    "raw": parsed,
                },
            )
        except Exception as exc:  # noqa: BLE001
            print("WeChat pay query exception:", repr(exc), flush=True)
            traceback.print_exc()
            self._send_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": {"message": f"支付状态查询失败：{exc}"}},
            )

    def _infer_client_ip(self) -> str:
        forwarded_for = str(self.headers.get("X-Forwarded-For", "")).strip()
        if forwarded_for:
            return forwarded_for.split(",")[0].strip() or "127.0.0.1"

        real_ip = str(self.headers.get("X-Real-IP", "")).strip()
        if real_ip:
            return real_ip

        return self.client_address[0] or "127.0.0.1"

    def _read_json_body(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length)
            return json.loads(raw_body.decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": {"message": "请求体不是合法 JSON。"}},
            )
            return None

    def _forward_json_request(
        self,
        *,
        url: str,
        api_key: str,
        payload: dict,
    ) -> tuple[int, dict]:
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }

        try:
            data = json.dumps(payload).encode("utf-8")
            upstream = request.Request(
                url,
                data=data,
                headers=headers,
                method="POST",
            )

            with request.urlopen(upstream, timeout=180) as response:
                body = response.read()
                status = response.status
        except error.HTTPError as exc:
            body = exc.read()
            status = exc.code
        except Exception as exc:  # noqa: BLE001
            print("Upstream proxy exception:", repr(exc), flush=True)
            traceback.print_exc()
            return HTTPStatus.BAD_GATEWAY, {"error": {"message": f"代理请求失败：{exc}"}}

        try:
            parsed = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            return HTTPStatus.BAD_GATEWAY, {"error": {"message": "上游返回了不可解析的响应。"}}

        return status, parsed

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format: str, *args) -> None:
        sys.stdout.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))
        sys.stdout.flush()

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    os.chdir(ROOT)
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"Serving on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


def _load_secrets_payload() -> dict:
    if not SECRETS_FILE.exists():
        return {}

    try:
        return json.loads(SECRETS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _load_secret(name: str) -> str:
    env_name = name.upper()
    env_value = os.environ.get(env_name, "").strip()
    if env_value:
        return env_value

    payload = _load_secrets_payload()
    return str(payload.get(name.lower(), "")).strip()


def load_openai_api_key() -> str:
    return _load_secret("openai_api_key")


def load_doubao_api_key() -> str:
    return _load_secret("doubao_api_key")


def load_doubao_image_model() -> str:
    return _load_secret("doubao_image_model") or DEFAULT_DOUBAO_IMAGE_MODEL


def load_doubao_image_url() -> str:
    return _load_secret("doubao_image_url") or DOUBAO_IMAGE_URL


def load_veimagex_ak() -> str:
    return _load_secret("veimagex_ak")


def load_veimagex_sk() -> str:
    return _load_secret("veimagex_sk")


def load_veimagex_service_id() -> str:
    return _load_secret("veimagex_service_id")


def load_veimagex_domain() -> str:
    return _load_secret("veimagex_domain")


def load_veimagex_template() -> str:
    return _load_secret("veimagex_template")


def load_veimagex_region() -> str:
    return _load_secret("veimagex_region") or DEFAULT_VEIMAGEX_REGION


def load_veimagex_model_action() -> str:
    return _load_secret("veimagex_model_action") or DEFAULT_VEIMAGEX_MODEL_ACTION


def load_veimagex_model_version() -> str:
    return _load_secret("veimagex_model_version") or DEFAULT_VEIMAGEX_MODEL_VERSION


def load_veimagex_req_key() -> str:
    return _load_secret("veimagex_req_key") or DEFAULT_VEIMAGEX_REQ_KEY


def load_wechat_pay_mchid() -> str:
    return _load_secret("wechat_pay_mchid")


def load_wechat_pay_appid() -> str:
    return _load_secret("wechat_pay_appid")


def load_wechat_pay_serial_no() -> str:
    return _load_secret("wechat_pay_serial_no")


def load_wechat_pay_notify_url() -> str:
    return _load_secret("wechat_pay_notify_url")


def load_wechat_pay_return_url() -> str:
    return _load_secret("wechat_pay_return_url")


def load_wechat_pay_h5_app_name() -> str:
    return _load_secret("wechat_pay_h5_app_name") or "宝宝颜值预测"


def load_wechat_pay_h5_app_url() -> str:
    return _load_secret("wechat_pay_h5_app_url")


def load_wechat_pay_private_key_path() -> Path | None:
    raw = _load_secret("wechat_pay_private_key_path")
    if not raw:
        return None

    path = Path(raw)
    if not path.is_absolute():
        path = (ROOT / path).resolve()
    return path


def is_wechat_pay_configured() -> bool:
    private_key_path = load_wechat_pay_private_key_path()
    required_values = [
        load_wechat_pay_mchid(),
        load_wechat_pay_appid(),
        load_wechat_pay_serial_no(),
        load_wechat_pay_notify_url(),
        load_wechat_pay_h5_app_name(),
        load_wechat_pay_h5_app_url(),
    ]

    if not all(required_values):
        return False

    return bool(private_key_path and private_key_path.exists() and private_key_path.is_file())


def is_veimagex_configured() -> bool:
    required_values = [
        load_veimagex_ak(),
        load_veimagex_sk(),
        load_veimagex_service_id(),
        load_veimagex_domain(),
        load_veimagex_template(),
    ]
    return bool(ImagexService and all(required_values))


def is_image_service_configured() -> bool:
    return is_veimagex_configured() or bool(load_doubao_api_key())


def build_order_no(action: str) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    suffix = uuid.uuid4().hex[:10].upper()
    prefix = "BG" if action == "analyze" else "RG"
    return f"{prefix}{timestamp}{suffix}"


def build_wechat_h5_order_body(*, order_no: str, client_ip: str) -> dict:
    expires = datetime.now(timezone.utc) + timedelta(minutes=15)
    h5_info = {
        "type": "Wap",
        "app_name": load_wechat_pay_h5_app_name(),
    }

    app_url = load_wechat_pay_h5_app_url()
    if app_url:
        h5_info["app_url"] = app_url

    return {
        "appid": load_wechat_pay_appid(),
        "mchid": load_wechat_pay_mchid(),
        "description": "宝宝颜值预测单次生成",
        "out_trade_no": order_no,
        "time_expire": expires.isoformat().replace("+00:00", "Z"),
        "notify_url": load_wechat_pay_notify_url(),
        "amount": {
            "total": WECHAT_PAY_AMOUNT_FEN,
            "currency": "CNY",
        },
        "scene_info": {
            "payer_client_ip": client_ip,
            "h5_info": h5_info,
        },
    }


def load_wechat_private_key():
    private_key_path = load_wechat_pay_private_key_path()
    if not private_key_path or not private_key_path.exists():
        raise FileNotFoundError("未找到微信支付商户私钥文件。")

    return serialization.load_pem_private_key(
        private_key_path.read_bytes(),
        password=None,
    )


def sign_wechat_message(message: str) -> str:
    private_key = load_wechat_private_key()
    signature = private_key.sign(
        message.encode("utf-8"),
        padding.PKCS1v15(),
        hashes.SHA256(),
    )
    return base64.b64encode(signature).decode("ascii")


def build_wechat_authorization(*, method: str, path: str, body_text: str) -> str:
    nonce_str = uuid.uuid4().hex
    timestamp = str(int(time.time()))
    canonical_message = f"{method}\n{path}\n{timestamp}\n{nonce_str}\n{body_text}\n"
    signature = sign_wechat_message(canonical_message)
    mchid = load_wechat_pay_mchid()
    serial_no = load_wechat_pay_serial_no()
    return (
        'WECHATPAY2-SHA256-RSA2048 '
        f'mchid="{mchid}",'
        f'nonce_str="{nonce_str}",'
        f'timestamp="{timestamp}",'
        f'serial_no="{serial_no}",'
        f'signature="{signature}"'
    )


def forward_wechat_request(*, method: str, path: str, payload: dict | None) -> tuple[int, dict]:
    body_text = "" if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    authorization = build_wechat_authorization(method=method, path=path, body_text=body_text)
    headers = {
        "Accept": "application/json",
        "Authorization": authorization,
        "User-Agent": "baby-face-forecast/1.0",
    }

    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = body_text.encode("utf-8")

    req = request.Request(
        url=f"{WECHAT_PAY_BASE_URL}{path}",
        data=data,
        headers=headers,
        method=method,
    )

    try:
        with request.urlopen(req, timeout=60) as response:
            raw = response.read()
            status = response.status
    except error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
    except Exception as exc:  # noqa: BLE001
        return HTTPStatus.BAD_GATEWAY, {"error": {"message": f"微信支付请求失败：{exc}"}}

    if not raw:
        return status, {}

    try:
        return status, json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        return HTTPStatus.BAD_GATEWAY, {"error": {"message": "微信支付返回了不可解析的响应。"}}


def generate_image_from_payload(
    payload: dict,
    forward_json_request,
) -> tuple[int, dict]:
    prompt = str(payload.get("prompt") or "").strip()
    baby_name = str(payload.get("babyName") or "宝宝").strip() or "宝宝"
    source_images = extract_source_images(payload)

    if not is_image_service_configured():
        return HTTPStatus.BAD_REQUEST, {"error": {"message": "后端未配置图片服务。"}}

    if not prompt:
        return HTTPStatus.BAD_REQUEST, {"error": {"message": "缺少图片生成 prompt。"}}

    if is_veimagex_configured() and source_images:
        try:
            return generate_with_veimagex(prompt=prompt, baby_name=baby_name, source_images=source_images)
        except Exception as exc:  # noqa: BLE001
            print("veImageX generation exception:", repr(exc), flush=True)
            traceback.print_exc()
            if not load_doubao_api_key():
                return HTTPStatus.BAD_GATEWAY, {"error": {"message": f"veImageX 图生图失败：{exc}"}}  # noqa: EM102

    if not load_doubao_api_key():
        return HTTPStatus.BAD_REQUEST, {"error": {"message": "图片服务未配置可用的回退模型。"}}

    image_request = {
        "model": load_doubao_image_model(),
        "prompt": prompt,
        "sequential_image_generation": "disabled",
        "response_format": "b64_json",
        "size": "2048x2048",
        "stream": False,
        "watermark": True,
    }

    status, parsed = forward_json_request(
        url=load_doubao_image_url(),
        api_key=load_doubao_api_key(),
        payload=image_request,
    )

    if status == HTTPStatus.OK:
        image_data = extract_doubao_image_data(parsed)
        if not image_data:
            message = extract_provider_error(parsed, default_message="图片服务返回了空结果。")
            return HTTPStatus.BAD_GATEWAY, {"error": {"message": message}}
    elif status >= HTTPStatus.BAD_REQUEST:
        print(f"Image provider error {status}: {extract_provider_error(parsed)}", flush=True)

    return status, parsed


def extract_source_images(payload: dict) -> list[str]:
    raw_items = payload.get("sourceImages")
    if not isinstance(raw_items, list):
        return []

    source_images: list[str] = []
    for item in raw_items[:2]:
        if isinstance(item, dict):
            data_url = str(item.get("dataUrl") or "").strip()
        else:
            data_url = str(item or "").strip()

        if data_url.startswith("data:image/"):
            source_images.append(data_url)

    return source_images


def generate_with_veimagex(*, prompt: str, baby_name: str, source_images: list[str]) -> tuple[int, dict]:
    reference_bytes = build_reference_image_bytes(source_images)
    store_key = upload_reference_image_to_veimagex(reference_bytes)
    reference_url = build_veimagex_reference_url(store_key)
    client = build_veimagex_client()

    body = {
        "Domain": load_veimagex_domain(),
        "Template": load_veimagex_template(),
        "ModelAction": load_veimagex_model_action(),
        "ModelVersion": load_veimagex_model_version(),
        "ImageUrl": reference_url,
        "Outputs": [build_veimagex_output_name(baby_name)],
        "Overwrite": True,
        "ReqJson": {
            "req_key": load_veimagex_req_key(),
            "prompt": prompt,
            "image_urls": [reference_url],
        },
    }

    response = client.get_cv_image_generate_result(
        {"ServiceId": load_veimagex_service_id()},
        body,
    )

    image_url = extract_veimagex_output_url(response)
    if not image_url:
        raise RuntimeError("veImageX 已返回成功，但没有拿到图片地址。")

    return HTTPStatus.OK, {
        "provider": "veimagex",
        "data": [{"url": image_url}],
        "raw": response,
    }


def build_veimagex_client():
    if not ImagexService:
        raise RuntimeError("未安装 volcengine Python SDK。")

    return ImagexService(
        {
            "ak": load_veimagex_ak(),
            "sk": load_veimagex_sk(),
            "region": load_veimagex_region(),
        }
    )


def build_reference_image_bytes(source_images: list[str]) -> bytes:
    images = [open_source_image(data_url) for data_url in source_images[:2]]
    if not images:
        raise RuntimeError("veImageX 图生图至少需要一张参考图。")

    if len(images) == 1:
        canvas = ImageOps.fit(images[0], (1024, 1024), LANCZOS)
    else:
        canvas = Image.new("RGB", (2048, 1024), "white")
        left = ImageOps.fit(images[0], (960, 960), LANCZOS)
        right = ImageOps.fit(images[1], (960, 960), LANCZOS)
        canvas.paste(left, (32, 32))
        canvas.paste(right, (1056, 32))

    output = io.BytesIO()
    canvas.save(output, format="JPEG", quality=92, optimize=True)
    return output.getvalue()


def open_source_image(data_url: str) -> Image.Image:
    raw_bytes = decode_data_url(data_url)
    return ImageOps.exif_transpose(Image.open(io.BytesIO(raw_bytes))).convert("RGB")


def decode_data_url(data_url: str) -> bytes:
    prefix, separator, encoded = data_url.partition(",")
    if not separator or ";base64" not in prefix:
        raise RuntimeError("参考图数据格式不正确。")
    return base64.b64decode(encoded)


def upload_reference_image_to_veimagex(image_bytes: bytes) -> str:
    store_key = build_reference_store_key()
    client = build_veimagex_client()
    client.upload_image_data(
        {
            "ServiceId": load_veimagex_service_id(),
            "StoreKeys": [store_key],
            "Overwrite": True,
        },
        [image_bytes],
    )
    return store_key


def build_reference_store_key() -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"{REFERENCE_UPLOAD_PREFIX}/{timestamp}-{uuid.uuid4().hex[:10]}.jpg"


def build_veimagex_reference_url(store_key: str) -> str:
    normalized_domain = load_veimagex_domain().strip().rstrip("/")
    safe_key = "/".join(quote(part, safe="._-~") for part in store_key.split("/"))
    return f"https://{normalized_domain}/{safe_key}"


def build_veimagex_output_name(baby_name: str) -> str:
    slug = "".join(ch for ch in baby_name if ch.isalnum()) or "baby"
    return f"{slug}-{uuid.uuid4().hex[:8]}.jpg"


def extract_veimagex_output_url(payload: dict) -> str:
    result = payload.get("Result")
    if not isinstance(result, dict):
        return ""

    for key in ("ImageUrls", "OutputImageUrls", "ImageURL"):
        value = result.get(key)
        if isinstance(value, list) and value:
            first = value[0]
            if isinstance(first, str) and first.strip():
                return first.strip()
            if isinstance(first, dict):
                for subkey in ("Url", "URL", "ImageUrl", "OutputUrl"):
                    candidate = str(first.get(subkey, "")).strip()
                    if candidate:
                        return candidate

    for key in ("ImageUrl", "OutputUrl", "Url"):
        candidate = str(result.get(key, "")).strip()
        if candidate:
            return candidate

    return ""


def extract_doubao_image_data(payload: dict) -> str:
    data = payload.get("data")
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict):
            return str(first.get("b64_json", "")).strip() or str(first.get("url", "")).strip()
    return ""


def extract_provider_error(payload: dict, default_message: str = "上游服务返回异常。") -> str:
    if isinstance(payload, dict):
        error_obj = payload.get("error")
        if isinstance(error_obj, dict):
            code = str(error_obj.get("code", "")).strip()
            message = str(error_obj.get("message", "")).strip()
            if code and message:
                return f"{code}: {message}"
            if message:
                return message

        code = str(payload.get("code", "")).strip()
        message = str(payload.get("message", "")).strip()
        if code and message:
            return f"{code}: {message}"
        if message:
            return message

    return default_message


if __name__ == "__main__":
    main()
