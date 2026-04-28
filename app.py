from __future__ import annotations

from http import HTTPStatus
from pathlib import Path
from urllib.parse import quote

from flask import Flask, jsonify, request as flask_request, send_from_directory

from server import (
    ROOT,
    WECHAT_PAY_AMOUNT_FEN,
    build_order_no,
    build_wechat_h5_order_body,
    extract_doubao_image_data,
    extract_provider_error,
    forward_wechat_request,
    is_wechat_pay_configured,
    load_doubao_api_key,
    load_doubao_image_model,
    load_doubao_image_url,
    load_openai_api_key,
    load_wechat_pay_mchid,
    load_wechat_pay_return_url,
)
from server import AppHandler as LocalAppHandler


app = Flask(__name__)

STATIC_FILES = {
    "index.html",
    "styles.css",
    "app.js",
    "launch_web.bat",
    "start_server.ps1",
    "README.md",
    "Procfile",
    "requirements.txt",
    ".env.example",
    "secrets.local.example.json",
}


def json_response(payload: dict, status: int = HTTPStatus.OK):
    response = jsonify(payload)
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    return response


def make_local_handler():
    handler = LocalAppHandler.__new__(LocalAppHandler)
    return handler


def forward_openai_request(upstream_request: dict) -> tuple[int, dict]:
    handler = make_local_handler()
    return handler._forward_json_request(  # noqa: SLF001
        url="https://api.openai.com/v1/responses",
        api_key=load_openai_api_key(),
        payload=upstream_request,
    )


def forward_image_request(prompt: str) -> tuple[int, dict]:
    handler = make_local_handler()
    image_request = {
        "model": load_doubao_image_model(),
        "prompt": prompt,
        "sequential_image_generation": "disabled",
        "response_format": "b64_json",
        "size": "2048x2048",
        "stream": False,
        "watermark": True,
    }
    return handler._forward_json_request(  # noqa: SLF001
        url=load_doubao_image_url(),
        api_key=load_doubao_api_key(),
        payload=image_request,
    )


@app.get("/api/config-status")
def config_status():
    image_ready = bool(load_doubao_api_key())
    analysis_ready = bool(load_openai_api_key())
    payment_ready = is_wechat_pay_configured()

    pay_message = "支付功能已配置。" if payment_ready else "支付功能未配置。"
    if image_ready and analysis_ready:
        message = f"图片服务已配置，分析服务也已配置。{pay_message}"
    elif image_ready:
        message = f"图片服务已配置；分析会优先走本地娱乐预测。{pay_message}"
    else:
        message = f"图片服务未配置。{pay_message}"

    return json_response(
        {
            "configured": image_ready,
            "imageConfigured": image_ready,
            "analysisConfigured": analysis_ready,
            "paymentConfigured": payment_ready,
            "message": message,
        }
    )


@app.post("/api/analyze")
def analyze():
    payload = flask_request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_response({"error": {"message": "请求体不是合法 JSON。"}}, HTTPStatus.BAD_REQUEST)

    upstream_request = payload.get("request")
    api_key = load_openai_api_key()

    if not api_key:
        return json_response({"error": {"message": "后端未配置 OpenAI API Key。"}}, HTTPStatus.BAD_REQUEST)

    if not isinstance(upstream_request, dict):
        return json_response({"error": {"message": "缺少可转发的请求参数。"}}, HTTPStatus.BAD_REQUEST)

    status, parsed = forward_openai_request(upstream_request)
    return json_response(parsed, status)


@app.post("/api/generate-image")
def generate_image():
    payload = flask_request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_response({"error": {"message": "请求体不是合法 JSON。"}}, HTTPStatus.BAD_REQUEST)

    prompt = str(payload.get("prompt") or "").strip()
    if not load_doubao_api_key():
        return json_response({"error": {"message": "后端未配置图片服务 API Key。"}}, HTTPStatus.BAD_REQUEST)

    if not prompt:
        return json_response({"error": {"message": "缺少图片生成 prompt。"}}, HTTPStatus.BAD_REQUEST)

    status, parsed = forward_image_request(prompt)
    if status == HTTPStatus.OK and not extract_doubao_image_data(parsed):
        message = extract_provider_error(parsed, default_message="图片服务返回了空结果。")
        return json_response({"error": {"message": message}}, HTTPStatus.BAD_GATEWAY)

    return json_response(parsed, status)


@app.post("/api/payment/create")
def payment_create():
    payload = flask_request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_response({"error": {"message": "请求体不是合法 JSON。"}}, HTTPStatus.BAD_REQUEST)

    if not is_wechat_pay_configured():
        return json_response({"error": {"message": "微信支付尚未配置，请先补齐商户参数。"}}, HTTPStatus.BAD_REQUEST)

    action = str(payload.get("action") or "analyze").strip().lower()
    if action not in {"analyze", "regenerate"}:
        return json_response({"error": {"message": "不支持的支付动作。"}}, HTTPStatus.BAD_REQUEST)

    try:
        client_ip = flask_request.headers.get("x-forwarded-for", "").split(",")[0].strip() or "127.0.0.1"
        order_no = build_order_no(action)
        body = build_wechat_h5_order_body(order_no=order_no, client_ip=client_ip)
        status, parsed = forward_wechat_request(method="POST", path="/v3/pay/transactions/h5", payload=body)

        if status != HTTPStatus.OK:
            message = extract_provider_error(parsed, default_message="微信支付下单失败。")
            return json_response({"error": {"message": message}}, status)

        pay_url = str(parsed.get("h5_url") or parsed.get("mweb_url") or "").strip()
        if not pay_url:
            return json_response(
                {"error": {"message": "微信支付已返回成功，但没有拿到支付链接。"}},
                HTTPStatus.BAD_GATEWAY,
            )

        redirect_url = load_wechat_pay_return_url()
        if redirect_url:
            separator = "&" if "?" in pay_url else "?"
            pay_url = f"{pay_url}{separator}redirect_url={quote(redirect_url, safe='')}"

        return json_response(
            {
                "orderNo": order_no,
                "action": action,
                "amount": WECHAT_PAY_AMOUNT_FEN,
                "payUrl": pay_url,
            }
        )
    except Exception as exc:  # noqa: BLE001
        return json_response({"error": {"message": f"支付订单创建失败：{exc}"}}, HTTPStatus.BAD_GATEWAY)


@app.get("/api/payment/status")
def payment_status():
    if not is_wechat_pay_configured():
        return json_response({"error": {"message": "微信支付尚未配置，请先补齐商户参数。"}}, HTTPStatus.BAD_REQUEST)

    order_no = str(flask_request.args.get("out_trade_no", "")).strip()
    if not order_no:
        return json_response({"error": {"message": "缺少 out_trade_no。"}}, HTTPStatus.BAD_REQUEST)

    path = f"/v3/pay/transactions/out-trade-no/{quote(order_no, safe='')}?mchid={quote(load_wechat_pay_mchid(), safe='')}"
    try:
        status, parsed = forward_wechat_request(method="GET", path=path, payload=None)
        if status != HTTPStatus.OK:
            message = extract_provider_error(parsed, default_message="支付状态查询失败。")
            return json_response({"error": {"message": message}}, status)

        trade_state = str(parsed.get("trade_state") or "").strip().upper()
        return json_response(
            {
                "orderNo": order_no,
                "paid": trade_state == "SUCCESS",
                "tradeState": trade_state or "UNKNOWN",
                "raw": parsed,
            }
        )
    except Exception as exc:  # noqa: BLE001
        return json_response({"error": {"message": f"支付状态查询失败：{exc}"}}, HTTPStatus.BAD_GATEWAY)


@app.get("/")
def root_index():
    return send_from_directory(ROOT, "index.html")


@app.get("/<path:asset_path>")
def serve_asset(asset_path: str):
    if asset_path.startswith("api/"):
        return json_response({"error": {"message": "Unknown endpoint."}}, HTTPStatus.NOT_FOUND)

    normalized = Path(asset_path)
    if normalized.name in STATIC_FILES and (ROOT / normalized.name).exists():
        return send_from_directory(ROOT, normalized.name)

    full_path = ROOT / asset_path
    if full_path.exists() and full_path.is_file() and ROOT in full_path.resolve().parents:
        return send_from_directory(ROOT, asset_path)

    return json_response({"error": {"message": "Not found."}}, HTTPStatus.NOT_FOUND)
