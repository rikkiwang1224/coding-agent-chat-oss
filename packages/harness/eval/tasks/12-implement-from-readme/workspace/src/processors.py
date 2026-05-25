"""Text processors — each takes a string and returns a string."""

import string


def lowercase(text: str) -> str:
    """Convert text to lowercase."""
    return text.lower()


def strip_whitespace(text: str) -> str:
    """Remove leading/trailing whitespace and collapse multiple internal spaces."""
    return " ".join(text.split())


def remove_punctuation(text: str) -> str:
    """Remove all punctuation characters."""
    return text.translate(str.maketrans("", "", string.punctuation))
