"""Tests for TaskManager — these must all pass after refactoring."""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.task_manager import TaskManager


def test_add_and_get():
    tm = TaskManager()
    t = tm.add_task("Write tests", "high")
    assert t["id"] == 1
    assert t["title"] == "Write tests"
    assert t["priority"] == "high"
    assert t["done"] is False
    fetched = tm.get_task(1)
    assert fetched == t


def test_complete():
    tm = TaskManager()
    tm.add_task("Task A")
    result = tm.complete_task(1)
    assert result["done"] is True
    assert tm.count_pending() == 0


def test_pending_filter():
    tm = TaskManager()
    tm.add_task("A")
    tm.add_task("B")
    tm.add_task("C")
    tm.complete_task(2)
    pending = tm.get_pending()
    assert len(pending) == 2
    assert all(t["title"] in ("A", "C") for t in pending)


def test_priority_filter():
    tm = TaskManager()
    tm.add_task("Low task", "low")
    tm.add_task("High task 1", "high")
    tm.add_task("High task 2", "high")
    tm.complete_task(2)
    high_pending = tm.get_by_priority("high")
    assert len(high_pending) == 1
    assert high_pending[0]["title"] == "High task 2"


def test_delete():
    tm = TaskManager()
    tm.add_task("To delete")
    tm.add_task("To keep")
    assert tm.delete_task(1) is True
    assert tm.delete_task(99) is False
    assert tm.count() == 1
    assert tm.get_task(1) is None


def test_count():
    tm = TaskManager()
    assert tm.count() == 0
    assert tm.count_pending() == 0
    tm.add_task("X")
    tm.add_task("Y")
    assert tm.count() == 2
    assert tm.count_pending() == 2
    tm.complete_task(1)
    assert tm.count() == 2
    assert tm.count_pending() == 1


if __name__ == "__main__":
    test_add_and_get()
    test_complete()
    test_pending_filter()
    test_priority_filter()
    test_delete()
    test_count()
    print("All TaskManager tests passed!")
