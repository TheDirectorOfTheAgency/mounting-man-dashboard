"""Seed normalization and nearby-city resolution.

Vendored verbatim from the canonical publisher
(`fast_install_post.py`, house-copy input normalization) so the cloud runner
produces byte-identical post data. Edit upstream first, then re-vendor.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from content import (
    load_location_id_city_map,
    multi_tv_job_details,
    slugify,
)

def _normalize_mount_type(value: str) -> str:
    raw = str(value or '').strip()
    text = raw.lower()
    if not text:
        return ''
    if 'mantelmount' in text or 'mantel mount' in text:
        model_match = re.search(r'\bmm\s*-?\s*(340|540|700|750|815|860)\b', raw, flags=re.IGNORECASE)
        return f"MantelMount MM{model_match.group(1)}" if model_match else 'MantelMount'
    if 'full motion' in text or 'full-motion' in text or 'articulating' in text:
        return 'full-motion'
    if 'tilt' in text:
        return 'tilting'
    if 'flush' in text:
        return 'flush-mount'
    if 'fixed' in text:
        return 'fixed'
    return text


def _normalize_price(value: Any) -> str:
    text = str(value or '').strip()
    if not text:
        return ''
    text = text.replace('$', '').replace(',', '').strip()
    try:
        return f"{float(text):.2f}"
    except Exception:
        return text


def _normalize_pricing_breakdown(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, Any] = {}
    key_map = {
        'processing_fee': 'processing-fee',
        'card-processing-fee': 'processing-fee',
        'card_processing_fee': 'processing-fee',
        'line_items': 'line-items',
    }
    for key, raw in value.items():
        canonical = key_map.get(str(key), str(key))
        if canonical == 'line-items':
            line_items = []
            for item in raw or []:
                if not isinstance(item, dict):
                    continue
                name = str(item.get('name') or item.get('label') or item.get('title') or '').strip()
                amount = _normalize_price(item.get('amount') or item.get('price') or item.get('value'))
                detail = str(item.get('detail') or item.get('description') or item.get('variant') or '').strip()
                quantity = str(item.get('quantity') or '').strip()
                if not name or not amount:
                    continue
                line_items.append({
                    'name': name,
                    'amount': amount,
                    'detail': detail,
                    'quantity': quantity,
                })
            if line_items:
                result['line-items'] = line_items
            continue
        normalized = _normalize_price(raw)
        if normalized:
            result[canonical] = normalized
    return result


SIGNAL_FRAGMENT_SPLIT_RE = re.compile(r'[\n\r|•;]+')


def _append_signal_text(parts: list[str], value: Any) -> None:
    if value in (None, '', [], {}):
        return
    if isinstance(value, dict):
        for inner in value.values():
            _append_signal_text(parts, inner)
        return
    if isinstance(value, (list, tuple, set)):
        for inner in value:
            _append_signal_text(parts, inner)
        return
    text = str(value).strip()
    if not text:
        return
    parts.append(text)
    for fragment in SIGNAL_FRAGMENT_SPLIT_RE.split(text):
        cleaned = str(fragment).strip(" \t\r\n-—,:•")
        if cleaned and cleaned != text:
            parts.append(cleaned)


def _seed_signal_text(seed: dict[str, Any]) -> str:
    parts: list[str] = []
    for key, value in seed.items():
        if str(key) in {'image-path', 'image_url', 'main-image', 'thumbnail-image'}:
            continue
        _append_signal_text(parts, value)
    return ' | '.join(parts).lower()


def _gallery_brand_matches(text: str) -> list[str]:
    matches: list[str] = []
    if 'samsung frame pro' in text:
        matches.append('Samsung Frame Pro')
    elif (
        'samsung frame' in text
        or 'frame by samsung' in text
        or 'samsung the frame' in text
        or 'the frame by samsung' in text
        or re.search(r'\b(?:samsung\s+)?(?:the\s+)?frame\s+tv\b', text)
        or re.search(r'\bthe frame\b', text)
    ):
        matches.append('Samsung Frame')
    if 'lg g series' in text or 'lg g-series' in text:
        matches.append('LG G-Series')
    if 'hisense canvas' in text:
        matches.append('Hisense Canvas')
    if 'tcl nxtframe' in text or 'tcl nxt frame' in text:
        matches.append('TCL NXTFRAME')
    deduped: list[str] = []
    for match in matches:
        if match not in deduped:
            deduped.append(match)
    return deduped


def _infer_brand_and_gallery(seed: dict[str, Any]) -> tuple[str, bool]:
    signal_parts: list[str] = []
    for key, value in seed.items():
        if str(key) in {'image-path', 'image_url', 'main-image', 'thumbnail-image'}:
            continue
        _append_signal_text(signal_parts, value)
    texts = [part.lower() for part in signal_parts if str(part).strip()]

    specific_matches: list[str] = []
    for fragment in texts:
        matches = _gallery_brand_matches(fragment)
        if len(matches) == 1:
            specific_matches.extend(matches)
    deduped_specific: list[str] = []
    for match in specific_matches:
        if match not in deduped_specific:
            deduped_specific.append(match)
    if len(deduped_specific) == 1:
        return deduped_specific[0], True
    if len(deduped_specific) > 1:
        return '', True

    text = ' | '.join(texts)
    gallery_matches = _gallery_brand_matches(text)
    gallery_hint = any(token in text for token in ['gallery style', 'gallery-style', 'picture frame', 'slim fit wall mount', 'one connect', 'frame tv', 'the frame'])
    if len(gallery_matches) == 1:
        return gallery_matches[0], True
    if len(gallery_matches) > 1:
        return '', True
    if gallery_hint:
        return '', True
    brands = {
        'onn. roku tv': 'onn. Roku TV',
        'onn roku': 'onn. Roku TV',
        'roku': 'Roku TV',
        'sony': 'Sony',
        'lg': 'LG',
        'samsung': 'Samsung',
        'hisense': 'Hisense',
        'tcl': 'TCL',
        'insignia': 'Insignia',
        'vizio': 'Vizio',
    }
    for token, brand in brands.items():
        if _brand_key_in_text(text, token):
            return brand, False
    return '', False


def _has_square_gallery_soundbar_collision(seed: dict[str, Any]) -> bool:
    if not any(seed.get(key) for key in ('source-payment-id', 'source-order-id', 'trigger-source-code')):
        return False

    fragments: list[str] = []
    for key in ('service-lines', 'job-notes'):
        _append_signal_text(fragments, seed.get(key))
    lowered = [
        fragment.lower()
        for fragment in fragments
        if not SIGNAL_FRAGMENT_SPLIT_RE.search(fragment)
    ]

    has_gallery_soundbar = any(
        'soundbar' in fragment and ('frame' in fragment or 'gallery' in fragment)
        for fragment in lowered
    )
    has_standard_tv_install = any(
        'tv installation' in fragment
        and not any(token in fragment for token in ('frame', 'gallery', 'canvas', 'nxtframe', 'g series'))
        for fragment in lowered
    )
    has_gallery_tv_install = any(
        'tv installation' in fragment
        and any(token in fragment for token in ('frame', 'gallery', 'canvas', 'nxtframe', 'g series'))
        for fragment in lowered
    )
    return has_gallery_soundbar and has_standard_tv_install and not has_gallery_tv_install


def normalize_seed_post_data(seed: dict[str, Any]) -> dict[str, Any]:
    result = dict(seed.get('seed') if isinstance(seed.get('seed'), dict) else seed)

    if 'wall-type' in result and 'wall-surface' not in result:
        result['wall-surface'] = result.get('wall-type')

    if result.get('mount-type'):
        result['mount-type'] = _normalize_mount_type(str(result.get('mount-type')))
    elif result.get('bracket-type'):
        result['mount-type'] = _normalize_mount_type(str(result.get('bracket-type')))

    if 'cord-concealment' not in result and result.get('cable-management'):
        cable = result.get('cable-management')
        if isinstance(cable, list):
            result['cord-concealment'] = [str(item).strip() for item in cable if str(item).strip()]
        else:
            result['cord-concealment'] = [str(cable).strip()]

    pricing = _normalize_pricing_breakdown(
        result.get('pricing-breakdown') or result.get('pricing_breakdown') or result.get('pricing')
    )
    if pricing:
        result['pricing-breakdown'] = pricing
        subtotal = pricing.get('subtotal')
        if subtotal:
            result['price'] = subtotal
        elif any(pricing.get(key) for key in ('tax', 'tip', 'processing-fee', 'total')):
            result.pop('price', None)

    if result.get('price'):
        result['price'] = _normalize_price(result.get('price'))

    if not result.get('local-reference') and result.get('street-name'):
        result['local-reference'] = str(result.get('street-name')).strip()

    signal_text = _seed_signal_text(result)
    if 'mantelmount' in signal_text or 'mantel mount' in signal_text:
        result['mantelmount'] = True
        if not result.get('mount-type') or str(result.get('mount-type')).strip().lower() in {'mount', 'tv mount', 'wall mount'}:
            result['mount-type'] = _normalize_mount_type(signal_text)

    inferred_brand, inferred_gallery = _infer_brand_and_gallery(result)
    existing_brand = str(result.get('tv-brand') or '').strip()
    existing_brand_lower = existing_brand.lower()

    if existing_brand_lower in {'samsung frame pro'}:
        result['tv-brand'] = 'Samsung Frame Pro'
    elif existing_brand_lower in {'samsung frame', 'frame by samsung', 'samsung the frame', 'the frame by samsung', 'frame tv', 'the frame', 'the frame tv'}:
        result['tv-brand'] = 'Samsung Frame'
    elif existing_brand_lower in {'lg g series', 'lg g-series'}:
        result['tv-brand'] = 'LG G-Series'
    elif existing_brand_lower in {'hisense canvas'}:
        result['tv-brand'] = 'Hisense Canvas'
    elif existing_brand_lower in {'tcl nxtframe', 'tcl nxt frame'}:
        result['tv-brand'] = 'TCL NXTFRAME'
    elif existing_brand_lower in {'samsung', 'samsung tv'} and (bool(result.get('gallery-style')) or inferred_gallery):
        result['tv-brand'] = 'Samsung Frame'
    elif not existing_brand and inferred_brand:
        result['tv-brand'] = inferred_brand
    elif (
        not existing_brand
        and bool(result.get('gallery-style'))
        and ('frame / gallery' in signal_text or 'frame gallery' in signal_text or 'gallery tv installation' in signal_text)
        and not any(token in signal_text for token in ['lg g series', 'lg g-series', 'hisense canvas', 'tcl nxtframe', 'tcl nxt frame'])
    ):
        result['tv-brand'] = 'Samsung Frame'

    brand = str(result.get('tv-brand') or '').strip().lower()
    brand_gallery = any(token in brand for token in ['frame', 'g series', 'g-series', 'canvas', 'nxtframe'])
    if inferred_gallery:
        result['gallery-style'] = True
    elif brand and 'gallery-style' not in result:
        result['gallery-style'] = brand_gallery

    if _has_square_gallery_soundbar_collision(result):
        if str(result.get('tv-brand') or '').strip().lower() in {'samsung frame', 'samsung frame pro'}:
            result['tv-brand'] = 'Samsung'
        result['gallery-style'] = False

    result.setdefault('gallery-style', False)
    result.setdefault('mantelmount', 'mantelmount' in str(result.get('mount-type') or '').lower())
    result.setdefault('tv-brand', '')
    result.setdefault('tv-size', 'TV')

    multi = multi_tv_job_details(result)
    if multi.get('is_multi_tv'):
        result.setdefault('tv-count', multi.get('tv_count'))
        if multi.get('tv_sizes'):
            result.setdefault('tv-sizes', multi.get('tv_sizes'))
    if multi.get('bracket_count'):
        result.setdefault('bracket-count', multi.get('bracket_count'))
    if multi.get('bracket_display'):
        result.setdefault('bracket-summary', multi.get('bracket_display'))
    return result


def load_seed_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError('Seed JSON must be an object')
    return normalize_seed_post_data(data)



def resolve_location_id(city: str, config) -> str:
    """Look up the Webflow location ID for a city."""
    location_map = load_location_id_city_map(config.location_ids_path)
    # Reverse map: city name -> location ID
    city_to_id = {v.lower(): k for k, v in location_map.items()}
    city_lower = city.lower().strip()
    if city_lower in city_to_id:
        return city_to_id[city_lower]
    # Fuzzy match
    for c, lid in city_to_id.items():
        if city_lower in c or c in city_lower:
            return lid
    return ""


# MSP metro nearby-cities lookup. Hand-tuned entries win; cities that are only
# present in references/location-ids.md fall back to their metro-area row.
_NEARBY_CITIES = {
    "Minneapolis": ["St. Paul", "Richfield", "St. Louis Park"],
    "St. Paul": ["Minneapolis", "Maplewood", "Roseville"],
    "Bloomington": ["Richfield", "Edina", "Burnsville"],
    "Edina": ["St. Louis Park", "Bloomington", "Richfield"],
    "Eden Prairie": ["Minnetonka", "Chanhassen", "Bloomington"],
    "Minnetonka": ["Eden Prairie", "Hopkins", "Wayzata"],
    "Plymouth": ["Maple Grove", "Wayzata", "Minnetonka"],
    "Maple Grove": ["Plymouth", "Brooklyn Park", "Rogers"],
    "Wayzata": ["Minnetonka", "Plymouth", "Orono"],
    "Eagan": ["Burnsville", "Apple Valley", "Inver Grove Heights"],
    "Burnsville": ["Eagan", "Apple Valley", "Savage"],
    "Apple Valley": ["Eagan", "Lakeville", "Burnsville"],
    "Lakeville": ["Apple Valley", "Farmington", "Burnsville"],
    "Farmington": ["Lakeville", "Rosemount", "Apple Valley"],
    "Rosemount": ["Farmington", "Eagan", "Apple Valley"],
    "Savage": ["Burnsville", "Prior Lake", "Shakopee"],
    "Shakopee": ["Savage", "Prior Lake", "Chaska"],
    "Prior Lake": ["Savage", "Shakopee", "Lakeville"],
    "Chaska": ["Chanhassen", "Shakopee", "Victoria"],
    "Chanhassen": ["Eden Prairie", "Chaska", "Victoria"],
    "Woodbury": ["Oakdale", "Cottage Grove", "Lake Elmo"],
    "Stillwater": ["Lake Elmo", "Mahtomedi", "Woodbury"],
    "Lake Elmo": ["Woodbury", "Stillwater", "Oakdale"],
    "Maplewood": ["St. Paul", "North St. Paul", "Oakdale"],
    "Oakdale": ["Maplewood", "Woodbury", "Lake Elmo"],
    "Brooklyn Park": ["Maple Grove", "Brooklyn Center", "Coon Rapids"],
    "Coon Rapids": ["Blaine", "Anoka", "Brooklyn Park"],
    "Blaine": ["Coon Rapids", "Lino Lakes", "Ham Lake"],
    "Richfield": ["Bloomington", "Edina", "Minneapolis"],
    "St. Louis Park": ["Minneapolis", "Hopkins", "Edina"],
    "Hopkins": ["St. Louis Park", "Minnetonka", "Edina"],
    "Golden Valley": ["St. Louis Park", "Crystal", "Minneapolis"],
    "Roseville": ["St. Paul", "Shoreview", "Arden Hills"],
    "White Bear Lake": ["Mahtomedi", "Vadnais Heights", "Shoreview"],
    "Cottage Grove": ["Woodbury", "Newport", "Hastings"],
    "Inver Grove Heights": ["Eagan", "South St. Paul", "Rosemount"],
    "Mendota Heights": ["Eagan", "South St. Paul", "Lilydale"],
    "Shoreview": ["Roseville", "Arden Hills", "Vadnais Heights"],
    "Fridley": ["Columbia Heights", "New Brighton", "Brooklyn Center"],
    "New Brighton": ["Fridley", "Arden Hills", "Mounds View"],
    "Chisago City": ["Forest Lake", "Hugo", "White Bear Lake"],
}


_LOCATION_IDS_PATH = Path(__file__).resolve().parents[1] / "references" / "location-ids.md"
_METRO_CITY_GROUPS_CACHE: dict[str, list[str]] | None = None


def _city_key(city: str) -> str:
    value = re.sub(r"\s+", " ", str(city or "").strip()).lower()
    aliases = {
        "saint paul": "st. paul",
        "st paul": "st. paul",
        "saint louis park": "st. louis park",
        "st louis park": "st. louis park",
        "saint anthony": "st. anthony",
        "st anthony": "st. anthony",
    }
    return aliases.get(value, value)


def _display_city_name(city: str) -> str:
    value = str(city or "").strip()
    return {
        "saint paul": "St. Paul",
        "st paul": "St. Paul",
        "saint louis park": "St. Louis Park",
        "st louis park": "St. Louis Park",
        "saint anthony": "St. Anthony",
        "st anthony": "St. Anthony",
    }.get(value.lower(), value)


def _parse_reference_metro_groups(path: Path = _LOCATION_IDS_PATH) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    if not path.exists():
        return groups
    in_metro = False
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("## Metro Area Values"):
            in_metro = True
            continue
        if not in_metro or not line.startswith("|"):
            continue
        parts = [part.strip() for part in line.strip("|").split("|")]
        if len(parts) < 2:
            continue
        metro, cities_raw = parts[0].replace("**", "").strip(), parts[1].strip()
        if metro in {"Metro Area", "------------"} or not cities_raw:
            continue
        cities = []
        for item in cities_raw.split(","):
            city = item.strip()
            if city.lower().endswith(" only"):
                city = city[:-5].strip()
            if city:
                cities.append(_display_city_name(city))
        if cities:
            groups[metro] = cities
    return groups


def _reference_metro_groups() -> dict[str, list[str]]:
    global _METRO_CITY_GROUPS_CACHE
    if _METRO_CITY_GROUPS_CACHE is None:
        _METRO_CITY_GROUPS_CACHE = _parse_reference_metro_groups()
    return _METRO_CITY_GROUPS_CACHE


def _nearby_from_reference_groups(city: str, limit: int = 3) -> list[str]:
    target = _city_key(city)
    for cities in _reference_metro_groups().values():
        keyed = [_city_key(candidate) for candidate in cities]
        if target not in keyed:
            continue
        idx = keyed.index(target)
        ranked = []
        for pos, candidate in enumerate(cities):
            if pos == idx:
                continue
            ranked.append((abs(pos - idx), pos, candidate))
        ranked.sort(key=lambda item: (item[0], item[1]))
        return [candidate for _, _, candidate in ranked[:limit]]
    return []


def _get_nearby_cities(city: str) -> list[str]:
    """Return up to 3 nearby cities for SEO interlinking."""
    target = _city_key(city)
    for known_city, nearby in _NEARBY_CITIES.items():
        if _city_key(known_city) == target:
            return nearby[:3]
    return _nearby_from_reference_groups(city, limit=3)



def _known_city_from_text(text: str) -> str:
    try:
        config = load_config()
        location_map = load_location_id_city_map(config.location_ids_path)
    except Exception:
        location_map = {}

    known_cities = set(location_map.values())
    known_cities.update({
        "St. Paul",
        "Saint Paul",
        "St. Louis Park",
        "Saint Louis Park",
    })

    for city in sorted(known_cities, key=len, reverse=True):
        if re.search(rf"(?<![A-Za-z]){re.escape(city)}(?![A-Za-z])", text, re.IGNORECASE):
            return city
    return ""


def _brand_key_in_text(text_lower: str, brand_key: str) -> bool:
    """Match TV brands as tokens, not substrings inside unrelated words."""
    key = str(brand_key or "").strip().lower()
    if not key:
        return False
    if key in {"onn", "onn."}:
        return bool(re.search(r"(?<![a-z0-9])onn\.?(?![a-z0-9])", text_lower))
    pattern = r"(?<![a-z0-9])" + r"\s+".join(
        re.escape(part) for part in re.split(r"\s+", key)
    ) + r"(?![a-z0-9])"
    return bool(re.search(pattern, text_lower))


def _has_cord_concealment_negative_signal(text_lower: str) -> bool:
    """Return True when text explicitly says cords are visible or not concealed."""
    patterns = [
        r"\bno\s+(?:cord|cable|wire)s?\s*(?:conceal|concealing|concealment|hiding|management|routing)\b",
        r"\bwithout\s+(?:cord|cable|wire)s?\s*(?:conceal|concealing|concealment|hiding|management|routing)\b",
        r"\bdid\s+not\s+(?:get|do|include)\s+(?:cord|cable|wire)s?\s*(?:conceal|concealing|concealment|hiding|management|routing)\b",
        r"\b(?:visible|exposed|hanging)\s+(?:cord|cable|wire)s?\b",
        r"\b(?:cord|cable|wire)s?\s+(?:visible|exposed|hanging|plugged\s+in)\b",
        r"\bplugged\s+into\s+(?:an?\s+)?outlet\s+below\b",
        r"\bno\s+in[- ]?wall\b",
    ]
    return any(re.search(pattern, text_lower) for pattern in patterns)
