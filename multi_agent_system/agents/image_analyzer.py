"""
Image analyzer — uses Replit AI / OpenAI vision to describe uploaded images.
Falls back to basic metadata if vision is unavailable.
"""
import base64, os, json

def analyze_image_b64(b64: str, mime: str = "image/png", name: str = "image") -> str:
    """Return a text description of an image given as base64."""

    # ── Try OpenAI-compatible vision (Replit AI or user key) ──
    try:
        from openai import OpenAI as _OpenAI

        # Pick the best available client
        client = None
        model  = None

        replit_base = os.environ.get("AI_INTEGRATIONS_OPENAI_BASE_URL", "")
        replit_key  = os.environ.get("AI_INTEGRATIONS_OPENAI_API_KEY", "dummy")
        user_key    = os.environ.get("OPENAI_API_KEY", "")

        if replit_base:
            client = _OpenAI(api_key=replit_key, base_url=replit_base, timeout=30.0, max_retries=0)
            model  = "gpt-4o-mini"
        elif user_key:
            client = _OpenAI(api_key=user_key, timeout=30.0, max_retries=0)
            model  = "gpt-4o-mini"

        if client and model:
            resp = client.chat.completions.create(
                model=model,
                messages=[{
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{mime};base64,{b64}", "detail": "high"},
                        },
                        {
                            "type": "text",
                            "text": (
                                f"Analyze this image ({name}). Describe in detail: "
                                "what is shown, any text/code/diagrams visible, colors, layout, "
                                "and anything the user would want to know or act on. "
                                "Be specific and thorough — this description will be used by an AI agent."
                            ),
                        },
                    ],
                }],
                max_tokens=1024,
            )
            return resp.choices[0].message.content.strip()
    except Exception as e:
        pass

    # ── Fallback: basic metadata ──
    try:
        raw = base64.b64decode(b64)
        size_kb = round(len(raw) / 1024, 1)

        # Detect format from magic bytes
        fmt = mime.split("/")[-1].upper()
        if raw[:4] == b'\x89PNG': fmt = "PNG"
        elif raw[:2] in (b'\xff\xd8', b'\xff\xe0'): fmt = "JPEG"
        elif raw[:4] == b'GIF8': fmt = "GIF"
        elif raw[:4] == b'RIFF': fmt = "WEBP"
        elif raw[:2] == b'BM': fmt = "BMP"

        # Try to read dimensions (PNG and JPEG)
        dims = ""
        try:
            if raw[:4] == b'\x89PNG':
                import struct
                w, h = struct.unpack('>II', raw[16:24])
                dims = f", {w}×{h}px"
        except Exception:
            pass

        return (
            f"[Image: {name} — {fmt}{dims}, {size_kb}KB. "
            f"Vision analysis unavailable — AI will work with this metadata. "
            f"MIME: {mime}]"
        )
    except Exception as e:
        return f"[Image attached: {name} ({mime}) — could not analyze: {e}]"
