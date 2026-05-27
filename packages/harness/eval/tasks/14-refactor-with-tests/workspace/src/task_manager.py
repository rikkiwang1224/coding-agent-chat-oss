"""
Task Manager — currently uses a flat list with linear search.
Works but is poorly structured. See task.json for refactoring instructions.
"""


class TaskManager:
    def __init__(self):
        self.tasks = []
        self.next_id = 1

    def add_task(self, title, priority="medium"):
        task = {
            "id": self.next_id,
            "title": title,
            "priority": priority,
            "done": False,
        }
        self.next_id += 1
        self.tasks.append(task)
        return task

    def complete_task(self, task_id):
        for task in self.tasks:
            if task["id"] == task_id:
                task["done"] = True
                return task
        return None

    def get_task(self, task_id):
        for task in self.tasks:
            if task["id"] == task_id:
                return task
        return None

    def get_pending(self):
        result = []
        for task in self.tasks:
            if not task["done"]:
                result.append(task)
        return result

    def get_by_priority(self, priority):
        result = []
        for task in self.tasks:
            if task["priority"] == priority and not task["done"]:
                result.append(task)
        return result

    def delete_task(self, task_id):
        for i, task in enumerate(self.tasks):
            if task["id"] == task_id:
                self.tasks.pop(i)
                return True
        return False

    def count(self):
        return len(self.tasks)

    def count_pending(self):
        c = 0
        for task in self.tasks:
            if not task["done"]:
                c += 1
        return c
