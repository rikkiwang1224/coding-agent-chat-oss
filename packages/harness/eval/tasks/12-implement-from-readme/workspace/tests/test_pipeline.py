"""Tests for the Pipeline class."""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.pipeline import Pipeline


def test_single_processor():
    p = Pipeline()
    p.add("lowercase")
    assert p.run("HELLO World") == "hello world"


def test_chaining():
    result = Pipeline().add("strip_whitespace").add("lowercase").run("  HELLO   World  ")
    assert result == "hello world"


def test_multiple_processors():
    p = Pipeline()
    p.add("strip_whitespace")
    p.add("remove_punctuation")
    p.add("lowercase")
    result = p.run("  Hello, World!  How are you?  ")
    assert result == "hello world how are you"


def test_len():
    p = Pipeline()
    assert len(p) == 0
    p.add("lowercase")
    assert len(p) == 1
    p.add("strip_whitespace")
    assert len(p) == 2


def test_clear():
    p = Pipeline().add("lowercase").add("strip_whitespace")
    assert len(p) == 2
    p.clear()
    assert len(p) == 0
    assert p.run("HELLO") == "HELLO"  # no processors → passthrough


def test_invalid_processor():
    p = Pipeline()
    try:
        p.add("nonexistent_function")
        assert False, "Should have raised ValueError"
    except ValueError:
        pass


def test_clear_chaining():
    result = Pipeline().add("lowercase").clear().add("strip_whitespace").run("  hello  world  ")
    assert result == "hello world"


if __name__ == "__main__":
    test_single_processor()
    test_chaining()
    test_multiple_processors()
    test_len()
    test_clear()
    test_invalid_processor()
    test_clear_chaining()
    print("All pipeline tests passed!")
