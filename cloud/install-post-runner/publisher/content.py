from __future__ import annotations

import hashlib
import html
import json
import re
from pathlib import Path

_UNIT_NUMBER_RE = re.compile(
    r"(?:#\s*[\w-]+|\b(?:apt|apartment|unit|suite|ste|bldg|building)\.?\s*[\w-]+|,\s*(?:no\.?|number|#)?\s*\d+[A-Za-z]?\b)",
    flags=re.IGNORECASE,
)


def _is_unmount_job(post_data: dict) -> bool:
    job_type = str(post_data.get("job-type") or post_data.get("job_type") or "").strip().lower()
    return job_type in {"unmount", "dismount", "takedown", "take-down"}


def _strip_unit_number(value: str) -> str:
    text = _UNIT_NUMBER_RE.sub(" ", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip(" ,")
    return text


def _unmount_local_reference(post_data: dict, city: str) -> str:
    raw = _clean_local_reference(
        str(post_data.get("local-reference") or post_data.get("street-name") or "").strip(),
        city,
    )
    return _strip_unit_number(raw)


def _unmount_visit_suffix(post_data: dict) -> str:
    try:
        count = int(post_data.get("seed-count") or 0)
        index = int(post_data.get("seed-index") or 0)
    except (TypeError, ValueError):
        return ""
    if count > 1 and index > 1:
        return str(index)
    return ""


def _unmount_unit_label(post_data: dict) -> str:
    size = str(post_data.get("tv-size") or "").strip()
    brand = _normalized_brand(post_data)
    parts = [part for part in [size, brand] if part]
    label = " ".join(parts).strip()
    if label and not label.lower().endswith("tv"):
        label = f"{label} TV"
    return label or "TV"


def _normalize_city_name(value: str) -> str:
    city = (value or "").strip()
    if not city:
        return city
    normalized = re.sub(r"\s+", " ", city).strip()
    aliases = {
        "st paul": "St. Paul",
        "saint paul": "St. Paul",
        "st. paul": "St. Paul",
        "st louis park": "St. Louis Park",
        "st. louis park": "St. Louis Park",
        "saint louis park": "St. Louis Park",
    }
    key = normalized.lower()
    if key in aliases:
        return aliases[key]
    return normalized


def _build_unit_label(size: str, brand: str, include_tv_suffix: bool = True) -> str:
    size = str(size or "TV").strip()
    brand = str(brand or "").strip()
    parts = [part for part in [size, brand] if part]
    label = " ".join(parts).strip()
    if include_tv_suffix and label and not label.lower().endswith("tv"):
        label = f"{label} TV"
    return label or "TV"


def _mount_display_label(mount_type: str) -> str:
    raw = str(mount_type or "mount").replace("-", " ").strip()
    value = raw.lower()
    model_match = re.search(r'\bmantel\s*mount\b|\bmantelmount\b', value)
    mm_match = re.search(r'\bmm\s*-?\s*(340|540|700|750|815|860)\b', raw, flags=re.IGNORECASE)
    if model_match:
        return f"MantelMount MM{mm_match.group(1)}" if mm_match else "MantelMount"
    mapping = {
        "fixed": "fixed mount",
        "full motion": "full-motion mount",
        "full-motion": "full-motion mount",
        "tilting": "tilting mount",
        "flush mount": "flush mount",
        "flush-mount": "flush mount",
        "mantelmount": "MantelMount",
    }
    return mapping.get(value, value or "mount")


def _specific_mount_label(mount_type: str) -> str:
    """Return a bracket label only when the source names an actual bracket style.

    Square/ZB jobs can say only "mount", "standard", or similar when the client
    already has a bracket. Those are service/category words, not bracket types,
    and they produce bad copy like "Why a Mount Works Well Here".
    """
    label = _mount_display_label(mount_type)
    generic = {
        "", "mount", "tv mount", "wall mount", "standard", "standard mount",
        "installation", "tv installation", "customer bracket", "customer supplied bracket",
        "customer-provided bracket", "client bracket", "existing bracket", "own bracket",
    }
    return "" if label.strip().lower() in generic else label


def _normalized_brand(post_data: dict) -> str:
    brand = str(post_data.get("tv-brand", "")).strip()
    if not brand:
        return ""
    lowered = brand.lower()
    if "samsung frame pro" in lowered:
        return "Samsung Frame Pro"
    if (
        "samsung frame" in lowered
        or "frame by samsung" in lowered
        or "samsung the frame" in lowered
        or "the frame by samsung" in lowered
        or lowered in {"frame tv", "the frame", "the frame tv"}
    ):
        return "Samsung Frame"
    if lowered in {"lg g series", "lg g-series"}:
        return "LG G-Series"
    if lowered in {"tcl nxtframe", "tcl nxt frame"}:
        return "TCL NXTFRAME"
    if lowered == "hisense canvas":
        return "Hisense Canvas"
    if bool(post_data.get("gallery-style")) and lowered in {"samsung", "samsung tv"}:
        return "Samsung Frame"
    return brand


def _brand_installation_intent(brand: str) -> tuple[str, str]:
    brand = str(brand or "").strip()
    brand_slug = slugify(brand)
    if not brand:
        return "TV Mounting", "tv-mounting"
    if brand.lower().endswith("tv"):
        return f"{brand} Installation", f"{brand_slug}-installation"
    return f"{brand} TV Installation", f"{brand_slug}-tv-installation"


def _clean_local_reference(value: str, city: str = "") -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if city:
        text = re.sub(
            rf",\s*{re.escape(city)}(?:,\s*(?:MN|Minnesota))?(?:\s+\d{{5}})?(?:,\s*USA)?$",
            "",
            text,
            flags=re.IGNORECASE,
        )
    text = re.sub(r",\s*(?:MN|Minnesota)(?:\s+\d{5})?(?:,\s*USA)?$", "", text, flags=re.IGNORECASE)
    text = re.sub(r",\s*USA$", "", text, flags=re.IGNORECASE)
    text = text.strip(" ,")

    # Never publish the exact service address/unit as the local reference. If
    # Square/ZB sends "14501 Grand Ave, 329, Burnsville, MN 55306, USA", keep
    # only the street name. Ordinal street names like "8th Avenue South" are
    # preserved because they do not start with a standalone house number.
    first_part = text.split(",", 1)[0].strip()
    if re.match(r"^\d+\s+\S+", first_part):
        street_only = re.sub(r"^\d+\s+", "", first_part).strip()
        if street_only:
            return street_only
    return text


def _primary_install_intent(post_data: dict) -> tuple[str, str]:
    if _is_unmount_job(post_data):
        return "TV Unmounting", "tv-unmounting"
    brand = _normalized_brand(post_data)
    mount_label = _specific_mount_label(post_data.get("mount-type") or post_data.get("bracket-type") or "")
    mount_slug = slugify(mount_label)
    gallery_style = bool(post_data.get("gallery-style"))
    fireplace = str(post_data.get("fireplace-type") or "").strip()

    if multi_tv_job_details(post_data).get("is_multi_tv"):
        return "Multi-TV Mounting", "multi-tv-mounting"
    if "mantelmount" in mount_slug:
        return "MantelMount Installation", "mantelmount-installation"
    if gallery_style and brand == "Samsung Frame Pro":
        return "Samsung Frame Pro TV Installation", "samsung-frame-pro-tv-installation"
    if gallery_style and brand.startswith("Samsung Frame"):
        return "Samsung Frame TV Installation", "samsung-frame-tv-installation"
    if gallery_style and brand and brand != "Gallery-Style":
        return _brand_installation_intent(brand)
    if gallery_style:
        return "Gallery-Style TV Installation", "gallery-style-tv-installation"
    if fireplace:
        return "Fireplace TV Mounting", "fireplace-tv-mounting"
    if brand and brand != "TV":
        return _brand_installation_intent(brand)
    return "TV Mounting", "tv-mounting"


def _is_samsung_frame_install(post_data: dict) -> bool:
    brand = _normalized_brand(post_data)
    return bool(post_data.get("gallery-style")) and brand.startswith("Samsung Frame")


def _is_samsung_frame_pro_install(post_data: dict) -> bool:
    brand = _normalized_brand(post_data)
    return bool(post_data.get("gallery-style")) and brand == "Samsung Frame Pro"


def _samsung_frame_install_label(post_data: dict) -> str:
    return "Samsung Frame Pro TV" if _is_samsung_frame_pro_install(post_data) else "Samsung Frame TV"


def build_seo_slug(post_data: dict, city: str) -> str:
    if _is_unmount_job(post_data):
        street = _unmount_local_reference(post_data, city)
        size = str(post_data.get("tv-size", "")).strip().replace('"', " inch")
        brand = _normalized_brand(post_data)
        surface = str(post_data.get("wall-surface", "")).strip()
        bits = ["tv-unmounting", city, size, brand, surface, street, _unmount_visit_suffix(post_data)]
        return slugify(_strip_unit_number(" ".join(bit for bit in bits if bit)))
    _, primary_slug = _primary_install_intent(post_data)
    brand = _normalized_brand(post_data)
    size = str(post_data.get("tv-size", "")).strip().replace('"', ' inch')
    mount_label = _specific_mount_label(post_data.get("mount-type") or post_data.get("bracket-type") or "")
    if _is_samsung_frame_install(post_data):
        mount_label = ""
    surface = str(post_data.get("wall-surface", "")).strip()
    local_reference = _clean_local_reference(
        str(post_data.get("local-reference") or post_data.get("street-name") or "").strip(),
        city,
    )

    multi = multi_tv_job_details(post_data)
    if multi.get("is_multi_tv"):
        bits = [primary_slug, city, f'{multi.get("tv_count")} TVs']
        if surface:
            bits.append(surface)
        if local_reference:
            bits.append(local_reference)
        return slugify(" ".join(bit for bit in bits if bit))

    bits = [primary_slug, city]
    if size:
        bits.append(size)
    if brand and slugify(brand) not in primary_slug:
        bits.append(brand)
    if mount_label and slugify(mount_label) not in primary_slug:
        bits.append(mount_label)
    if surface:
        bits.append(surface)
    if local_reference:
        bits.append(local_reference)
    return slugify(" ".join(bit for bit in bits if bit))


def slugify(value: str) -> str:
    value = (value or "").strip().lower()
    chars = []
    last_dash = False
    for ch in value:
        if ch.isalnum():
            chars.append(ch)
            last_dash = False
        elif not last_dash:
            chars.append("-")
            last_dash = True
    return "".join(chars).strip("-")


def load_location_id_city_map(path: Path) -> dict[str, str]:
    mapping: dict[str, str] = {}
    if not path.exists():
        return mapping
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        parts = [part.strip() for part in line.strip("|").split("|")]
        if len(parts) < 2:
            continue
        city, location_id = parts[0], parts[1]
        if city in {"City", "------"}:
            continue
        if re.fullmatch(r"[a-f0-9]{24}", location_id):
            mapping[location_id] = city
    return mapping


def parse_city(post_data: dict, location_id_to_city: dict[str, str]) -> str:
    if post_data.get("city"):
        return _normalize_city_name(str(post_data["city"]).strip())
    location_id = str(post_data.get("location-id", "")).strip()
    if location_id in location_id_to_city:
        return _normalize_city_name(location_id_to_city[location_id])
    title = str(post_data.get("title", "")).strip()
    if " in " in title:
        return _normalize_city_name(title.rsplit(" in ", 1)[-1].split("|", 1)[0].strip())
    return "Twin Cities"


def ensure_list(value) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [part.strip() for part in str(value).replace("|", ",").split(",") if part.strip()]


_SERVICE_LINE_DELIMS = ("—", "–", " - ")


def _collect_service_lines(post_data: dict) -> list[str]:
    raw = post_data.get("service-lines") or post_data.get("service_lines")
    if isinstance(raw, list):
        lines = [str(item).strip() for item in raw if str(item).strip()]
    elif isinstance(raw, str) and raw.strip():
        lines = [part.strip() for part in re.split(r"[;\n\r]+", raw) if part.strip()]
    else:
        notes = str(post_data.get("job-notes") or post_data.get("job_notes") or "").strip()
        lines = [part.strip() for part in re.split(r"[;\n\r]+", notes) if part.strip()] if notes else []
    return lines


def _expand_service_quantity(line: str) -> tuple[str, int]:
    match = re.search(r"[\(\[]?\s*(?:x|×|qty\s*)\s*(\d+)\s*[\)\]]?\s*$", line, re.IGNORECASE)
    if not match:
        return line.strip(), 1
    return line[: match.start()].strip(), max(1, int(match.group(1)))


def _split_service_item_variation(line: str) -> tuple[str, str]:
    for delim in _SERVICE_LINE_DELIMS:
        if delim in line:
            item, _, variation = line.partition(delim)
            return item.strip(), variation.strip()
    return line.strip(), ""


def _is_tv_install_line(item: str, line: str) -> bool:
    text = f"{item} {line}".lower()
    return "tv installation" in text or "tv install" in text


def _tv_size_from_service_line(item: str, variation: str, line: str) -> str:
    candidates = [variation, line, item]
    for candidate in candidates:
        text = str(candidate or "").strip()
        match = re.search(r"\b(under\s*)?(\d{2,3})\s*(?:[\"“”]|inch|in\b)?", text, re.IGNORECASE)
        if not match:
            continue
        size = f'{match.group(2)}"'
        if match.group(1):
            return f"Under {size}"
        return size
    return "TV"


def _is_bracket_line(item: str, variation: str, line: str) -> bool:
    text = f"{item} {variation} {line}".lower()
    if "bracket" in text and ("mount" in text or "tv" in text):
        return True
    return bool(re.search(r"\b(?:standard\s+)?(?:tilt|tilting|fixed|full[-\s]*motion|mantelmount|mantel\s+mount)\b.*\b(?:mount|bracket)\b", text))


def _clean_bracket_label(value: str) -> str:
    text = re.sub(r"\s+", " ", str(value or "").replace("/", " ")).strip(" -—–")
    if not text:
        return ""
    lower = text.lower()
    if lower in {"regular", "standard", "mount", "bracket", "tv mount bracket", "tv mount"}:
        return ""
    text = re.sub(r"\btv\b", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\bmounting\s+bracket\b", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\bmount\s+bracket\b", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\bwall\s+mount\b", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:mount|bracket)\b", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip(" -—–")
    lower = text.lower()
    if not lower or lower in {"regular", "standard"}:
        return ""
    if "full" in lower and "motion" in lower:
        return "Full-Motion"
    if "tilt" in lower:
        return "Standard Tilt" if "standard" in lower else "Tilt"
    if "fixed" in lower:
        return "Fixed"
    if "mantelmount" in lower or "mantel mount" in lower:
        model = re.search(r"\bmm\s*-?\s*(340|540|700|750|815|860)\b", text, flags=re.IGNORECASE)
        return f"MantelMount MM{model.group(1)}" if model else "MantelMount"
    return text.title()


def _bracket_label_from_service_line(item: str, variation: str) -> str:
    variation_label = _clean_bracket_label(variation)
    if variation_label:
        return variation_label
    return _clean_bracket_label(item) or "Mounting"


def _join_display(items: list[str]) -> str:
    items = [str(item).strip() for item in items if str(item).strip()]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return ", ".join(items[:-1]) + f", and {items[-1]}"


def _grouped_tv_sizes_display(sizes: list[str]) -> str:
    grouped: list[tuple[str, int]] = []
    for size in sizes:
        if grouped and grouped[-1][0] == size:
            grouped[-1] = (size, grouped[-1][1] + 1)
            continue
        for index, (existing, count) in enumerate(grouped):
            if existing == size:
                grouped[index] = (existing, count + 1)
                break
        else:
            grouped.append((size, 1))
    return _join_display([f"{size} ({count})" if count > 1 else size for size, count in grouped])


def _bracket_groups_display(groups: list[dict[str, object]]) -> str:
    parts = []
    for group in groups:
        label = str(group.get("type") or "Mounting").strip()
        count = int(group.get("count") or 0)
        if count <= 0:
            continue
        noun = "bracket" if count == 1 else "brackets"
        if label.lower() == "mounting":
            parts.append(f"{count} {noun}")
        else:
            parts.append(f"{count} {label} {noun}")
    return _join_display(parts)


def multi_tv_job_details(post_data: dict) -> dict[str, object]:
    """Infer job-level TV/bracket counts from Square service lines.

    The normal one-TV path still works from `tv-size`; this only adds richer
    details when a combined Square payment includes several TV installation lines
    plus separate bracket/mount hardware lines.
    """
    sizes: list[str] = []
    bracket_groups: list[dict[str, object]] = []
    fireplace_count = 0

    for raw_line in _collect_service_lines(post_data):
        line, quantity = _expand_service_quantity(raw_line)
        item, variation = _split_service_item_variation(line)
        if _is_tv_install_line(item, line):
            size = _tv_size_from_service_line(item, variation, line)
            for _ in range(quantity):
                sizes.append(size)
                if "fireplace" in line.lower():
                    fireplace_count += 1
            continue
        if _is_bracket_line(item, variation, line):
            label = _bracket_label_from_service_line(item, variation)
            for group in bracket_groups:
                if str(group.get("type")) == label:
                    group["count"] = int(group.get("count") or 0) + quantity
                    break
            else:
                bracket_groups.append({"type": label, "count": quantity})

    explicit_sizes = ensure_list(post_data.get("tv-sizes") or post_data.get("tv_sizes"))
    if not sizes and explicit_sizes:
        sizes = explicit_sizes
    explicit_count = post_data.get("tv-count") or post_data.get("tv_count")
    try:
        tv_count = max(len(sizes), int(explicit_count or 0))
    except (TypeError, ValueError):
        tv_count = len(sizes)
    if not sizes and tv_count > 1:
        sizes = [str(post_data.get("tv-size") or "TV").strip() or "TV"] * tv_count

    bracket_count = sum(int(group.get("count") or 0) for group in bracket_groups)
    return {
        "is_multi_tv": tv_count > 1,
        "tv_count": tv_count,
        "tv_sizes": sizes,
        "tv_sizes_display": _join_display(sizes),
        "tv_sizes_grouped_display": _grouped_tv_sizes_display(sizes),
        "fireplace_count": fireplace_count,
        "bracket_count": bracket_count,
        "bracket_groups": bracket_groups,
        "bracket_display": _bracket_groups_display(bracket_groups),
    }


def build_seo_title(post_data: dict, city: str) -> str:
    if _is_unmount_job(post_data):
        size = str(post_data.get("tv-size") or "").strip()
        brand = _normalized_brand(post_data)
        surface = str(post_data.get("wall-surface") or "").strip()
        street = _unmount_local_reference(post_data, city)
        bits = [bit for bit in [size, brand, surface] if bit]
        if street:
            bits.append(f"Near {street}")
        suffix = _unmount_visit_suffix(post_data)
        if suffix:
            bits.append(suffix)
        title = f"TV Unmounting in {city}" if not bits else f"TV Unmounting in {city} | {' '.join(bits)}"
        return _strip_unit_number(title)
    brand = _normalized_brand(post_data)
    size = str(post_data.get("tv-size", "TV")).strip()
    room = str(post_data.get("room-type", "")).replace("-", " ").strip()
    surface = str(post_data.get("wall-surface", "")).strip()
    mount_label = _specific_mount_label(post_data.get("mount-type") or post_data.get("bracket-type") or "")
    fireplace = str(post_data.get("fireplace-type") or "").strip()
    gallery_style = bool(post_data.get("gallery-style"))
    local_reference = _clean_local_reference(
        str(post_data.get("local-reference") or post_data.get("street-name") or "").strip(),
        city,
    )
    primary, _ = _primary_install_intent(post_data)
    primary_slug = slugify(primary)

    multi = multi_tv_job_details(post_data)
    if multi.get("is_multi_tv"):
        bits = [f'{multi.get("tv_count")} TVs']
        if surface and surface.lower() != "drywall":
            bits.append(surface)
        if room:
            bits.append(room.title())
        if local_reference:
            bits.append(f"Near {local_reference}")
        return f"{primary} in {city}" if not bits else f"{primary} in {city} | {' '.join(bits)}"

    if _is_samsung_frame_install(post_data):
        suffix_bits = []
        if size:
            suffix_bits.append(size)
        if surface and (surface.lower() != "drywall" or fireplace):
            suffix_bits.append(surface)
        if room:
            suffix_bits.append(room.title())
        if local_reference:
            suffix_bits.append(f"Near {local_reference}")
        title = f"{_samsung_frame_install_label(post_data)} Installation in {city}"
        return title if not suffix_bits else f"{title} | {' '.join(suffix_bits)}"

    bits = [size] if size else []
    if brand and slugify(brand) not in primary_slug:
        bits.append(brand)
    if mount_label and slugify(mount_label) not in primary_slug:
        bits.append(mount_label if mount_label.startswith("MantelMount") else mount_label.title())
    if surface and (surface.lower() != "drywall" or gallery_style or (fireplace and not post_data.get("mantelmount"))):
        bits.append(surface)
    if room:
        bits.append(room.title())
    if local_reference:
        bits.append(f"Near {local_reference}")
    return f"{primary} in {city}" if not bits else f"{primary} in {city} | {' '.join(bits)}"


def performer_context(post_data: dict) -> dict[str, str | bool]:
    raw = str(post_data.get("performed-by") or post_data.get("installer-name") or "").strip()
    normalized = raw.lower()

    # First-person: empty, known self-references, or noise from Square data extraction.
    # Square team_member_ids are 10+ char alphanumeric IDs starting with "TM" — never
    # a real name, so they default to first-person Marshall.
    looks_like_square_id = (
        len(raw) >= 10 and raw[:2].upper() == "TM" and raw[2:].replace("-", "").isalnum()
    )
    first_person_tokens = {
        "", "i", "me", "marshall", "marshall wayne", "marshall (owner)",
        "payment", "card", "invoice", "completed", "charge", "unknown", "owner",
    }
    if not raw or normalized in first_person_tokens or looks_like_square_id:
        return {
            "is_first_person": True,
            "name": "I",
            "completed": "I completed",
            "service_local": "I spend plenty of time",
        }

    # Everything else = a named helper (e.g. "Michael"). Pass through.
    return {
        "is_first_person": False,
        "name": raw,
        "completed": f"{raw} completed",
        "service_local": "The team spends plenty of time",
    }


def _normalize_money_value(value) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = text.replace("$", "").replace(",", "").strip()
    try:
        amount = float(text)
    except Exception:
        return text
    return f"{amount:.2f}"


def _format_money_display(value) -> str | None:
    normalized = _normalize_money_value(value)
    return f"${normalized}" if normalized else None


def _state_display(post_data: dict) -> str:
    state = str(post_data.get("state") or post_data.get("state-name") or "").strip()
    if state:
        return state
    state_code = str(post_data.get("state-code") or post_data.get("state_abbr") or "").strip().upper()
    state_names = {
        "MN": "Minnesota",
        "TX": "Texas",
        "VA": "Virginia",
        "DC": "District of Columbia",
        "MD": "Maryland",
    }
    return state_names.get(state_code, state_code)


def _location_display(post_data: dict, city: str, local_reference: str) -> str:
    state = _state_display(post_data)
    if local_reference:
        return f"{local_reference}, {city}"
    if state:
        return f"{city}, {state}"
    return city


_CITY_SERVICE_SLUG_OVERRIDES = {
    "anoka": "anoka-0c1a3",
    "blaine": "blaine-d4c08",
    "champlin": "champlin-8521d",
    "circle pines": "circle-pines-9680f",
    "columbia heights": "columbia-heights-8f67e",
    "coon rapids": "coon-rapids-fe70d",
    "dayton": "dayton-3102f",
    "lino lakes": "lino-lakes-3b47c",
    "maple plain": "maple-plain-553b2",
    "mounds view": "mounds-view-de2dd",
    "new brighton": "new-brighton-7997d",
    "osseo": "osseo-477c8",
    "rogers": "rogers-6d853",
    "spring lake park": "spring-lake-park-84017",
    "st. anthony": "st-anthony-c649f",
}

_CITY_SERVICE_SLUGS_PATH = Path(__file__).resolve().parents[1] / "references" / "location-slugs.json"
_CITY_SERVICE_SLUGS_CACHE: dict[str, str] | None = None

_CITY_SERVICE_PAGELESS_CITIES = {
    "chisago city",
}


def _load_city_service_slugs(path: Path = _CITY_SERVICE_SLUGS_PATH) -> dict[str, str]:
    global _CITY_SERVICE_SLUGS_CACHE
    if _CITY_SERVICE_SLUGS_CACHE is not None:
        return _CITY_SERVICE_SLUGS_CACHE
    slugs: dict[str, str] = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            raw_cities = data.get("cities") if isinstance(data, dict) else {}
            if isinstance(raw_cities, dict):
                for city, slug in raw_cities.items():
                    city_key = _normalize_city_name(str(city)).lower()
                    slug_value = str(slug or "").strip().strip("/")
                    if city_key and slug_value:
                        slugs[city_key] = slug_value
        except Exception:
            slugs = {}
    _CITY_SERVICE_SLUGS_CACHE = slugs
    return slugs


def _city_service_slug(city: str) -> str:
    city = _normalize_city_name(city)
    city_key = city.lower()
    return (
        _load_city_service_slugs().get(city_key)
        or _CITY_SERVICE_SLUG_OVERRIDES.get(city_key)
        or slugify(city)
    )


def _city_service_link(city: str, label: str | None = None) -> str:
    city = _normalize_city_name(city)
    link_label = label or f"TV mounting in {city}"
    slug = _city_service_slug(city)
    return f'<a href="https://www.themountingman.com/tv-mounting/{slug}">{html.escape(link_label)}</a>'


def _city_service_reference(city: str) -> str:
    city = _normalize_city_name(city)
    label = f"TV mounting in {city}"
    if city.lower() in _CITY_SERVICE_PAGELESS_CITIES:
        return html.escape(label)
    return _city_service_link(city, label)


def _service_context_link(post_data: dict) -> str:
    text = " ".join(
        str(post_data.get(key, ""))
        for key in ("title", "slug", "post-summary", "job-notes", "wall-surface", "mount-type", "tv-brand")
    ).lower()
    if "frame" in text or bool(post_data.get("gallery-style")):
        return '<a href="https://www.themountingman.com/service/samsung-frame-installation">Samsung Frame TV installation</a>'
    if "mantelmount" in text:
        return '<a href="https://www.themountingman.com/service/mantelmount-installation">MantelMount installation</a>'
    if "fireplace" in text:
        return '<a href="https://www.themountingman.com/service/mount-tv-above-fireplace">fireplace TV mounting</a>'
    if "conference" in text or "commercial" in text or "office" in text or "gym" in text:
        return '<a href="https://www.themountingman.com/service/corporate-worksite-installation">commercial TV mounting</a>'
    return '<a href="https://www.themountingman.com/service/tv-mounting">professional TV mounting services</a>'


def _service_area_paragraph(post_data: dict, city: str, nearby_cities: list[str]) -> str:
    metro_area = str(post_data.get("metro-area") or "").strip()
    state = _state_display(post_data)
    city_link = _city_service_reference(city)
    nearby_links = [_city_service_link(nearby_city, _normalize_city_name(nearby_city)) for nearby_city in nearby_cities[:3]]
    service_link = _service_context_link(post_data)
    parts = [f"This local install is part of our {city_link} work."]
    if nearby_cities:
        parts.append(f"Nearby service areas include {', '.join(nearby_links)}.")
    elif metro_area and metro_area.lower() not in {city.lower(), "twin cities"}:
        parts.append(f"We also handle similar installations throughout the {html.escape(metro_area)}.")
    elif state:
        parts.append(f"We also handle similar installations around {html.escape(city)}, {html.escape(state)}.")
    parts.append(f"For the broader service, see our {service_link}.")
    return " ".join(parts)


def _pricing_breakdown(post_data: dict) -> dict:
    raw = post_data.get("pricing-breakdown") or post_data.get("pricing_breakdown") or post_data.get("pricing")
    if not isinstance(raw, dict):
        return {}
    result: dict[str, object] = {}
    for key in ("subtotal", "tax", "tip", "processing-fee", "processing_fee", "card-processing-fee", "card_processing_fee", "total"):
        if raw.get(key) in (None, ""):
            continue
        canonical = {
            "processing_fee": "processing-fee",
            "card-processing-fee": "processing-fee",
            "card_processing_fee": "processing-fee",
        }.get(key, key)
        normalized = _normalize_money_value(raw.get(key))
        if normalized:
            result[canonical] = normalized
    line_items = []
    for item in raw.get("line-items", raw.get("line_items", [])) or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("label") or item.get("title") or "").strip()
        amount = _normalize_money_value(item.get("amount") or item.get("price") or item.get("value"))
        detail = str(item.get("detail") or item.get("description") or item.get("variant") or "").strip()
        quantity = str(item.get("quantity") or "").strip()
        if not name or not amount:
            continue
        line_items.append({
            "name": name,
            "amount": amount,
            "detail": detail,
            "quantity": quantity,
        })
    if line_items:
        result["line-items"] = line_items
    return result


def _display_price_raw(post_data: dict) -> str:
    pricing = _pricing_breakdown(post_data)
    subtotal = pricing.get("subtotal") if isinstance(pricing, dict) else None
    if subtotal:
        return str(subtotal)
    if pricing:
        return ""
    return _normalize_money_value(post_data.get("price", ""))


def display_price_subtotal(post_data: dict) -> str | None:
    """Return the public-facing install price (e.g. '$250') or None.

    Uses `pricing.subtotal` from the seed when present, otherwise shows the
    explicit `price` value as entered. Do not infer a subtotal from a charged
    total unless the seed provides a structured breakdown.
    Whole-dollar amounts drop the trailing ".00" ("$250" not "$250.00").
    Used by both the website install body and social-media captions so the price
    shown to prospects is consistent across CMS and social copy.
    """
    formatted = _format_money_display(_display_price_raw(post_data))
    if formatted and formatted.endswith(".00"):
        formatted = formatted[:-3]
    return formatted


def build_installation_details(post_data: dict, city: str) -> str:
    city = _normalize_city_name(city)
    local_reference = _clean_local_reference(
        str(post_data.get("local-reference") or post_data.get("street-name") or "").strip(),
        city,
    )
    mount_type = str(post_data.get("mount-type") or post_data.get("bracket-type") or "").replace("-", " ").strip()
    pricing = _pricing_breakdown(post_data)
    # Samsung Frame uses proprietary Slim Fit Wall Mount, not generic "fixed"
    gallery_style = bool(post_data.get("gallery-style"))
    brand_lower = str(post_data.get("tv-brand", "")).lower()
    if gallery_style and "samsung" in brand_lower:
        mount_type = "Samsung Slim Fit Wall Mount"
    elif gallery_style:
        mount_type = "flush mount"
    else:
        mount_type = _specific_mount_label(mount_type)
    location_value = _location_display(post_data, city, local_reference)
    price_display = display_price_subtotal(post_data)
    performer = performer_context(post_data)
    if performer["is_first_person"]:
        tech_label, tech_name = "Service Technician", "Marshall (Owner)"
    elif performer["name"] and performer["name"] != "I":
        tech_label, tech_name = "Service Technician", performer["name"]
    else:
        tech_label, tech_name = "Service Technician", None
    multi = multi_tv_job_details(post_data)
    tv_details = [
        ("TVs Mounted", f'{multi.get("tv_count")} TVs'),
        ("TV Sizes", multi.get("tv_sizes_display")),
    ] if multi.get("is_multi_tv") else [("TV Size", post_data.get("tv-size"))]
    details = [
        *tv_details,
        ("TV Brand", post_data.get("tv-brand")),
        ("Wall Type", post_data.get("wall-surface")),
        ("Mount Type", mount_type.title() if mount_type else None),
        ("Brackets Used", multi.get("bracket_display")),
        (tech_label, tech_name),
        (("Installation Subtotal" if pricing.get("subtotal") else "Price"), price_display),
        ("Location", location_value),
    ]
    cord_display = _cord_concealment_display(post_data)
    if cord_display:
        cord_bullet = "Yes" if cord_display == "cord concealment" else cord_display
        details.insert(-1, ("Cord Concealment", cord_bullet))
    lines = ["<h2>Installation Details</h2>", "<ul>"]
    for label, value in details:
        if value:
            lines.append(f"<li><strong>{label}:</strong> {value}</li>")
    for item in pricing.get("line-items", []) or []:
        detail_bits = []
        if item.get("detail"):
            detail_bits.append(str(item["detail"]))
        if item.get("quantity"):
            detail_bits.append(f'x{item["quantity"]}')
        suffix = f' ({"; ".join(detail_bits)})' if detail_bits else ""
        lines.append(f'<li><strong>{item["name"]}:</strong> ${item["amount"]}{suffix}</li>')
    lines.append("</ul>")
    return "\n".join(lines)


def _cord_concealment_display(post_data: dict) -> str:
    methods = post_data.get("cord-concealment") or post_data.get("cord-concealing") or post_data.get("cord-method") or []
    if isinstance(methods, bool):
        return "cord concealment" if methods else ""
    if isinstance(methods, str):
        methods = [methods]
    labels = []
    omitted = {"unknown", "unk", "n/a", "na", "none", "no", "not provided", "null", "nil", "false"}
    affirmative = {"yes", "true", "y", "1", "yep", "yeah"}
    for method in methods or []:
        text = str(method or "").replace("-", " ").strip()
        if not text or text.lower() in omitted:
            continue
        if text.lower() in affirmative:
            if "cord concealment" not in labels:
                labels.append("cord concealment")
            continue
        labels.append(text.title())
    return ", ".join(labels)


def _fireplace_phrase(post_data: dict) -> str:
    fireplace = re.sub(r"\s+", " ", str(post_data.get("fireplace-type") or "").replace("-", " ")).strip()
    if fireplace:
        descriptor = fireplace[:1].lower() + fireplace[1:]
        if descriptor.lower() == "fireplace":
            return "above a fireplace"
        article = "an" if descriptor[:1].lower() in "aeiou" else "a"
        if "fireplace" in descriptor.lower():
            return f"above {article} {descriptor}"
        return f"above {article} {descriptor} fireplace"
    room = str(post_data.get("room-type", "")).replace("-", " ").strip()
    if "fireplace" in room.lower():
        return "above the fireplace"
    return ""


def build_distinctive_install_section(post_data: dict, city: str, *, unit_label: str, mount_type: str, surface: str, local_reference: str) -> str:
    """Add job-specific facts so real installs do not read like interchangeable CMS variants."""
    city = _normalize_city_name(city)
    brand = _normalized_brand(post_data)
    gallery_style = bool(post_data.get("gallery-style"))
    fireplace_phrase = _fireplace_phrase(post_data)
    cord_display = _cord_concealment_display(post_data)
    performer = performer_context(post_data)
    price_display = display_price_subtotal(post_data)
    multi = multi_tv_job_details(post_data)
    points: list[str] = []

    if local_reference:
        points.append(f"Completed near {html.escape(local_reference)} in {html.escape(city)}, mounted level and secured into the {html.escape(surface)}.")
    if multi.get("is_multi_tv"):
        points.append(
            f"Multi-TV job: {multi.get('tv_count')} TVs total, with sizes {html.escape(str(multi.get('tv_sizes_display') or multi.get('tv_sizes_grouped_display') or 'TVs'))}."
        )
    if multi.get("bracket_display"):
        points.append(f"Mount hardware used: {html.escape(str(multi.get('bracket_display')))}.")
    if gallery_style and brand == "Samsung Frame Pro":
        if "recessed outlet" in cord_display.lower():
            points.append("Samsung Frame Pro plugs in like a normal TV, so the recessed outlet swap keeps the power plug from pushing the screen off the wall.")
        else:
            points.append("Samsung Frame Pro mounted as a gallery-style display; power placement matters because it plugs in like a normal TV instead of using the standard Frame's long One Connect cable.")
    elif gallery_style and brand.startswith("Samsung Frame"):
        points.append("Samsung Frame mounted with the Slim Fit Wall Mount so the finished setup reads like wall art, not a standard black TV hanging off the wall.")
    elif gallery_style:
        points.append(f"Gallery-style display mounted flush for a low-profile finished look on {html.escape(surface)}.")
    if fireplace_phrase:
        points.append(f"TV positioned {html.escape(fireplace_phrase)} with mounting height, heat, and viewing angle handled before drilling.")
    if surface and surface.lower() not in {"drywall", "wall"}:
        points.append(f"Mounted on {html.escape(surface)}, which requires the right drill technique, anchor selection, and careful leveling for a clean finish.")
    if mount_type:
        points.append(f"Mount type for this job: {html.escape(mount_type)}.")
    if cord_display:
        if "recessed outlet" in cord_display.lower():
            points.append("Recessed outlet swap lets the plug sit back inside the wall so the TV can mount flush instead of being pushed out by a standard plug.")
        elif cord_display == "cord concealment":
            points.append("Cables concealed so nothing hangs below the screen.")
        else:
            points.append(f"{html.escape(cord_display)} cord concealment keeps the cables hidden behind the wall.")
    if price_display:
        points.append(f"Install subtotal: {html.escape(price_display)}.")
    if not performer["is_first_person"] and performer.get("name"):
        points.append(f"Installed by {html.escape(str(performer['name']))} for this completed local job.")

    if not points:
        points.append(f"{html.escape(unit_label)} mounted level and secured on {html.escape(surface)} in {html.escape(city)}.")
    lines = ["<h2>What Made This Install Different</h2>", "<ul>"]
    for point in points[:5]:
        lines.append(f"<li>{point}</li>")
    lines.append("</ul>")
    return "\n".join(lines)


def generate_post_summary(post_data: dict, city: str) -> str:
    if _is_unmount_job(post_data):
        city = _normalize_city_name(city)
        street = _unmount_local_reference(post_data, city)
        wall = str(post_data.get("wall-surface") or "").strip()
        summary = f"{_unmount_unit_label(post_data)} unmounting in {city}"
        if wall:
            summary += f" on {wall.lower()}"
        if street:
            summary += f", completed near {street}"
        summary += ". The photo is the before shot, with the TV still on the wall."
        price_display = display_price_subtotal(post_data)
        if price_display:
            summary += f" Completed for {price_display}."
        return _strip_unit_number(summary)
    city = _normalize_city_name(city)
    size = str(post_data.get("tv-size", "TV"))
    brand = _normalized_brand(post_data)
    surface = str(post_data.get("wall-surface", "wall")).lower()
    mount_type = str(post_data.get("mount-type", "installation")).replace("-", " ")
    gallery_style = bool(post_data.get("gallery-style"))
    brand_lower = brand.lower() if brand else ""
    local_reference = _clean_local_reference(
        str(post_data.get("local-reference") or post_data.get("street-name") or "").strip(),
        city,
    )
    unit_label = _build_unit_label(size, brand, include_tv_suffix=True)
    performer = performer_context(post_data)
    pricing = _pricing_breakdown(post_data)
    price_display = display_price_subtotal(post_data)
    price_label = " Installation subtotal" if pricing.get("subtotal") else " Completed for"
    price_note = f"{price_label} {price_display}." if price_display else ""
    multi = multi_tv_job_details(post_data)

    if multi.get("is_multi_tv"):
        size_text = str(multi.get("tv_sizes_display") or multi.get("tv_sizes_grouped_display") or "").strip()
        summary = f'{multi.get("tv_count")}-TV installation in {city} on {surface}'
        if size_text:
            summary += f", with sizes {size_text}"
        if multi.get("bracket_display"):
            summary += f" and {multi.get('bracket_display')} used"
    elif gallery_style and brand_lower.startswith("samsung frame"):
        summary = f"{size} {brand} TV installation in {city} on {surface}"
    elif gallery_style:
        summary = f"{unit_label} installation in {city} on {surface}"
    else:
        summary = f"{unit_label} installation in {city} on {surface}"

    if local_reference:
        summary += f", completed near {local_reference}"
    if not performer["is_first_person"]:
        summary += f" by {performer['name']}"
    summary += "."
    return summary + price_note


def choose_variant(seed: str, options: list[str]) -> str:
    digest = hashlib.md5(seed.encode("utf-8")).hexdigest()
    return options[int(digest[:8], 16) % len(options)]



# Surface-specific installation challenges and risks — used in post body
_SURFACE_CHALLENGES = {
    "ceramic tile": (
        "Ceramic tile is one of the more demanding surfaces for TV mounting. "
        "Drilling requires a diamond or carbide bit at low speed — tile cracks sideways and chips easily "
        "if rushed or forced. The installer has to hit studs behind the tile and backer board for a secure hold, "
        "and there is real liability with every hole. One slip means a cracked tile that cannot be patched invisibly. "
        "That is why professional installation matters — patience and precision prevent costly damage."
    ),
    "tile": (
        "Tile installations require careful drilling with specialty bits to avoid cracking or chipping. "
        "The tile and backer board add thickness that requires longer lag bolts, "
        "and finding studs behind tile takes extra precision. "
        "Whether ceramic or porcelain, tile is unforgiving — one bad hole is permanent."
    ),
    "porcelain tile": (
        "Porcelain tile is even harder than ceramic and more prone to shattering under drill pressure. "
        "It requires diamond-tipped bits, low RPM, and steady hands. "
        "Cracking or chipping is a real liability — the cost of replacing a single tile "
        "can exceed the cost of the mount itself. Professional installation eliminates that risk."
    ),
    "stone": (
        "Stone fireplaces look great but present real mounting challenges. "
        "The uneven surface requires shimming and careful anchor placement, "
        "and drilling into stone or mortar demands masonry bits and patience to avoid cracking."
    ),
    "stacked stone": (
        "Stacked stone is one of the trickiest surfaces to mount a TV on. "
        "The irregular surface means no two contact points are level — getting the TV straight requires shimming "
        "and custom spacers at every anchor point. Stone chips easily if you are not careful with the drill, "
        "and imprecise drilling means more holes than necessary in expensive stonework. "
        "Done professionally, you do not have to worry about any of that."
    ),
    "natural stone": (
        "Natural stone varies in hardness and thickness, making every installation unique. "
        "The installer has to assess the stone type, drill with the right masonry bit, "
        "and use appropriate anchors — lag bolts into studs when possible, or tapcons into solid stone."
    ),
    "stone veneer": (
        "Stone veneer looks like solid stone but is typically a thin decorative layer over drywall or cement board. "
        "Mounting directly into veneer alone will fail — the bolts have to reach the studs behind it. "
        "The challenge is drilling through the veneer cleanly without cracking or chipping."
    ),
    "marble": (
        "Marble is beautiful but unforgiving. Any misplaced hole is visible forever. "
        "Drilling requires diamond-tipped bits at low RPM with water cooling to prevent heat cracks. "
        "The mount has to be positioned perfectly the first time — there are no second chances."
    ),
    "slate": (
        "Slate tends to flake and split along its natural layers, making drilling risky. "
        "The installer has to use sharp masonry bits at low speed and avoid over-tightening, "
        "which can crack the slate and leave visible damage."
    ),
    "brick": (
        "Brick mounting requires drilling into the mortar joints or the brick itself with masonry bits. "
        "The key risk is cracking the brick, especially on older homes where the masonry may be brittle. "
        "Clean layout and slower drilling matter more here than they would on a standard drywall wall."
    ),
    "wood panel": (
        "Wood paneling can hide what is underneath — sometimes drywall and studs, sometimes nothing. "
        "The installer has to verify what is behind the panel and ensure the mount anchors into something structural, "
        "not just the thin paneling itself."
    ),
    "shiplap": (
        "Shiplap is decorative wood over drywall or studs. It looks clean but adds thickness that requires longer hardware. "
        "The mount has to be anchored through the shiplap into the studs behind it — mounting to shiplap alone will not hold."
    ),
    "concrete": (
        "Concrete walls require hammer drilling with masonry bits and concrete anchors. "
        "There are no studs to find, so the anchors do all the work. "
        "The main risk is hitting rebar or conduit behind the surface."
    ),
    "plaster": (
        "Plaster walls are common in older homes and can crumble when drilled. "
        "The installer has to find the wood lath or studs behind the plaster and use the right technique "
        "to avoid blowing out a large section of the wall."
    ),
    "fireplace": (
        "Fireplace mounting adds complexity regardless of the surface material. "
        "Heat exposure, uneven surfaces, and limited stud access behind the mantel "
        "all require careful planning to ensure a secure and safe installation."
    ),
}


def _generate_unmount_post_body(post_data: dict, city: str) -> str:
    city = _normalize_city_name(city)
    street = _unmount_local_reference(post_data, city)
    size = str(post_data.get("tv-size") or "").strip()
    brand = _normalized_brand(post_data)
    wall = str(post_data.get("wall-surface") or "").strip()
    price_display = display_price_subtotal(post_data)
    unit_label = html.escape(_unmount_unit_label(post_data))
    location = f"{html.escape(street)}, {html.escape(city)}" if street else html.escape(city)
    heading = f"TV Unmounting Near {html.escape(street)}" if street else f"TV Unmounting in {html.escape(city)}"
    where = f"near {html.escape(street)} in {html.escape(city)}" if street else f"in {html.escape(city)}"
    nearby_cities = ensure_list(post_data.get("nearby-cities"))

    details = ["<h2>Job Details</h2>", "<ul>", "<li><strong>Service:</strong> TV Unmounting</li>"]
    if size:
        details.append(f"<li><strong>TV Size:</strong> {html.escape(size)}</li>")
    if brand:
        details.append(f"<li><strong>TV Brand:</strong> {html.escape(brand)}</li>")
    if wall:
        details.append(f"<li><strong>Wall Type:</strong> {html.escape(wall)}</li>")
    if price_display:
        details.append(f"<li><strong>Price:</strong> {html.escape(price_display)}</li>")
    details.extend([f"<li><strong>Location:</strong> {location}</li>", "</ul>"])

    points = [
        (
            f"Completed near {html.escape(street)} in {html.escape(city)}. This was a TV unmount, not a new mount."
            if street
            else f"This was a TV unmount in {html.escape(city)}, not a new mount."
        )
    ]
    if price_display:
        points.append(f"Unmount subtotal: {html.escape(price_display)}.")
    points.append("The required photo is the before shot, with the TV still on the wall.")

    # Famous-mounter CTA is unchanged: same service-area paragraph as mounts.
    body = "\n".join([
        "\n".join(details),
        f"<h2>{heading}</h2>",
        f"<p>We took down this {unit_label} {where}. The photo for this job is the before shot, with the TV still on the wall.</p>",
        "<h2>What Made This Unmount Different</h2>",
        "<ul>",
        *[f"<li>{point}</li>" for point in points],
        "</ul>",
        "<h2>Taking a TV Off the Wall</h2>",
        "<p>A clean unmount means supporting the TV, backing out the hardware, and walking the screen off the wall without damaging the set or the surface. This job was a take-down, not a mount.</p>",
        f"<h2>TV Mounting in {html.escape(city)}</h2>",
        f"<p>{_service_area_paragraph(post_data, city, nearby_cities)}</p>",
    ])
    return _strip_unit_number(body)


def generate_post_body(post_data: dict, city: str) -> str:
    if _is_unmount_job(post_data):
        return _generate_unmount_post_body(post_data, city)
    city = _normalize_city_name(city)
    size = str(post_data.get("tv-size", "TV"))
    brand = str(post_data.get("tv-brand", "")).strip()
    surface = str(post_data.get("wall-surface", "wall")).lower()
    mount_type = str(post_data.get("mount-type") or post_data.get("bracket-type") or "mount").replace("-", " ").strip()
    # Samsung Frame uses proprietary Slim Fit Wall Mount
    gallery_style = bool(post_data.get("gallery-style"))
    brand_lower = brand.lower()
    if gallery_style and "samsung" in brand_lower:
        mount_type = "Samsung Slim Fit Wall Mount"
    elif gallery_style:
        mount_type = "flush mount"
    else:
        mount_type = _specific_mount_label(mount_type)
    local_reference = _clean_local_reference(
        str(post_data.get("local-reference") or post_data.get("street-name") or "").strip(),
        city,
    )
    nearby_cities = ensure_list(post_data.get("nearby-cities"))
    unit_label = _build_unit_label(size, brand)
    multi = multi_tv_job_details(post_data)
    if multi.get("is_multi_tv"):
        unit_label = f'{multi.get("tv_count")} TVs'

    mount_phrase = f" with a {mount_type}" if mount_type else ""
    fireplace_phrase = _fireplace_phrase(post_data)
    cord_display = _cord_concealment_display(post_data)
    room = str(post_data.get("room-type", "")).replace("-", " ").strip()
    price_display = display_price_subtotal(post_data)
    if multi.get("is_multi_tv"):
        heading_one = f"Multi-TV Mounting Near {local_reference}" if local_reference else f"Multi-TV Mounting in {city}"
    elif gallery_style and "samsung" in brand.lower():
        frame_label = _samsung_frame_install_label(post_data)
        heading_one = f"{frame_label} Installation Near {local_reference}" if local_reference else f"{frame_label} Installation in {city}"
    elif fireplace_phrase:
        heading_one = f"Fireplace TV Mounting Near {local_reference}" if local_reference else f"Fireplace TV Mounting in {city}"
    elif local_reference:
        heading_one = f"Clean TV Mounting Near {local_reference}"
    else:
        heading_one = f"Clean TV Mounting in {city}"

    location_sentence = f"near {local_reference} in {city}" if local_reference else f"in {city}"
    detail_clauses = [f"on {surface}"]
    if mount_type:
        detail_clauses[0] = f"on {surface} with a {mount_type}"
    if fireplace_phrase:
        detail_clauses.append(fireplace_phrase)
    if room and room.lower() not in heading_one.lower():
        detail_clauses.append(f"in the {room}")
    cord_sentence = ""
    if cord_display:
        if "recessed outlet" in cord_display.lower():
            cord_sentence = " We completed a recessed outlet swap so the plug sits back inside the wall and the TV can mount flush."
        else:
            cord_phrase = "the cabling concealed" if cord_display == "cord concealment" else f"{cord_display.lower()} cord concealment"
            cord_sentence = f" We finished it with {cord_phrase} so no wires show below the screen."
    price_sentence = f" The install subtotal came to {price_display}." if price_display else ""
    if multi.get("is_multi_tv"):
        size_sentence = str(multi.get("tv_sizes_display") or multi.get("tv_sizes_grouped_display") or "").strip()
        bracket_sentence = f" The job used {multi.get('bracket_display')}." if multi.get("bracket_display") else ""
        fireplace_sentence = ""
        if int(multi.get("fireplace_count") or 0):
            fireplace_sentence = f" {multi.get('fireplace_count')} of the TVs were over-fireplace installs."
        first_paragraph = (
            f"We mounted {multi.get('tv_count')} TVs {location_sentence}, {', '.join(detail_clauses)}."
            f" The TV sizes were {size_sentence}."
            f"{bracket_sentence}"
            f"{fireplace_sentence}"
            f"{cord_sentence}"
            f"{price_sentence}"
        )
    else:
        first_paragraph = (
            f"We mounted this {unit_label} {location_sentence}, {', '.join(detail_clauses)}."
            f"{cord_sentence}"
            f"{price_sentence}"
        )

    if gallery_style and "samsung" in brand.lower():
        is_frame_pro = _is_samsung_frame_pro_install(post_data)
        second_heading = "Why the Samsung Frame Pro Setup Is Different" if is_frame_pro else "Why the Samsung Frame Stands Out"
        cord_methods = [
            method.lower()
            for method in ensure_list(post_data.get("cord-concealment", []))
            if _cord_concealment_display({"cord-concealment": [method]})
        ]
        cord_copy = ""
        if is_frame_pro:
            if any("recessed" in m for m in cord_methods):
                cord_copy = (
                    " The Frame Pro plugs in like a normal TV instead of using the standard Frame's long One Connect cable. "
                    "A recessed outlet lets the plug sit back inside the wall so the screen can keep the flush gallery-style finish."
                )
            elif cord_methods:
                cord_copy = (
                    " The Frame Pro plugs in like a normal TV instead of using the standard Frame's long One Connect cable, "
                    "so power placement matters for the final flush look."
                )
        elif any("one-connect" in m for m in cord_methods):
            cord_copy = (
                " The Samsung Frame uses an external One Connect box for all its inputs. "
                "Routing the One Connect cable through the fireplace cavity or wall keeps everything hidden "
                "so there are no visible wires breaking the gallery look."
            )
        elif any("recessed" in m for m in cord_methods):
            method_names = [m for m in cord_methods if "recessed" in m]
            cord_copy = (
                f" Cord concealment is a major part of a clean Frame installation. "
                f"A {method_names[0]} keeps all wiring hidden behind the wall "
                "so there are no visible cables breaking the gallery look."
            )
        elif cord_methods:
            cord_copy = (
                " Clean cord concealment is part of what makes a Frame installation look finished — "
                "no visible cables, just art on the wall."
            )
        if is_frame_pro:
            second_paragraph = (
                f"The Samsung Frame Pro is still a gallery-style display, so the goal is a clean, nearly flush finish against the {surface}. "
                "Unlike the standard Samsung Frame setup with a long One Connect cable, the Frame Pro's normal power plug makes outlet placement part of the installation plan. "
                "Precise leveling, stud placement, and power placement all matter to keep the final look clean."
                f"{cord_copy}"
            )
        else:
            second_paragraph = (
                f"The Samsung Frame comes with its own Slim Fit Wall Mount designed to sit nearly flush against the {surface}. "
                "When mounted correctly, it looks like a framed piece of art rather than a TV. "
                "Precise leveling and stud placement are critical to getting that seamless gallery look."
                f"{cord_copy}"
            )
    else:
        surface_challenge = _SURFACE_CHALLENGES.get(surface, _SURFACE_CHALLENGES.get(surface.split()[0] if surface else "", ""))
        if surface_challenge:
            second_heading = f"Mounting on {surface.title()}"
            bracket_display = str(multi.get("bracket_display") or "").strip()
            hardware_sentence = (
                f"This job used {bracket_display}."
                if bracket_display else
                f"This job used a {mount_type}."
                if mount_type else
                "The bracket was leveled and anchored into the wall for a solid, lasting hold."
            )
            second_paragraph = (
                f"{surface_challenge} "
                f"{hardware_sentence}"
                + (
                    " Cord concealment completes the job — no dangling cables, just a clean wall."
                    if post_data.get("cord-concealment") else ""
                )
            )
        else:
            if mount_type:
                second_heading = f"Why a {mount_type.title()} Works Well Here"
                mount_type_key = mount_type.lower().replace("-", " ")
                if "full motion" in mount_type_key:
                    second_paragraph = (
                        "A full-motion mount lets the TV pull away from the wall and angle left or right, "
                        "which helps when seating is not straight in front of the screen. "
                        f"For this {surface} install, that gives the setup more flexibility than a fixed mount while keeping the finished look clean."
                    )
                elif "tilt" in mount_type_key:
                    second_paragraph = (
                        "A tilting mount keeps the TV close to the wall while allowing a small vertical angle adjustment. "
                        f"For this {surface} install, that helps fine-tune the viewing angle without making the setup look bulky."
                    )
                elif "fixed" in mount_type_key or "flush" in mount_type_key:
                    second_paragraph = (
                        "A fixed mount keeps the screen close to the wall for a cleaner, lower-profile look. "
                        f"For this {surface} install, the goal was a straightforward finished setup without extra bracket movement."
                    )
                else:
                    second_paragraph = (
                        f"This {surface} installation used a {mount_type}, leveled and anchored so the screen sits solid and square on the wall."
                    )
            else:
                second_heading = "Clean, Secure Wall Mounting"
                second_paragraph = (
                    f"For this {surface} install, the bracket was anchored into the wall and the TV leveled for a clean, secure hold that stays put."
                )

    third_heading = f"TV Mounting in {city}"
    third_paragraph = _service_area_paragraph(post_data, city, nearby_cities)

    return "\n".join([
        build_installation_details(post_data, city),
        f"<h2>{heading_one}</h2>",
        f"<p>{first_paragraph}</p>",
        build_distinctive_install_section(post_data, city, unit_label=unit_label, mount_type=mount_type, surface=surface, local_reference=local_reference),
        f"<h2>{second_heading}</h2>",
        f"<p>{second_paragraph}</p>",
        f"<h2>{third_heading}</h2>",
        f"<p>{third_paragraph}</p>",
    ])


def enrich_post_data(post_data: dict, location_id_to_city: dict[str, str]) -> dict:
    result = dict(post_data)
    city = parse_city(result, location_id_to_city)
    result["city"] = city
    if not str(result.get("title", "")).strip():
        result["title"] = build_seo_title(result, city)
    if not str(result.get("slug", "")).strip():
        result["slug"] = build_seo_slug(result, city)
    if not str(result.get("post-summary", "")).strip():
        result["post-summary"] = generate_post_summary(result, city)
    if not str(result.get("post-body", "")).strip():
        result["post-body"] = generate_post_body(result, city)
    return result
