# Text Pipeline

A simple text processing pipeline library. Each processor is a function that takes a string and returns a string.

## Architecture

All processors live in `src/processors.py`. The pipeline runner lives in `src/pipeline.py`.

## Existing Processors

- `lowercase(text)` — Convert text to lowercase
- `strip_whitespace(text)` — Remove leading/trailing whitespace and collapse multiple spaces into one
- `remove_punctuation(text)` — Remove all punctuation characters

## TODO: Implement `src/pipeline.py`

The `Pipeline` class must follow this interface:

```python
class Pipeline:
    def __init__(self):
        """Initialize an empty pipeline."""
    
    def add(self, processor_name: str) -> "Pipeline":
        """
        Add a processor by name (e.g., "lowercase", "strip_whitespace").
        Should look up the function from src/processors.py.
        Raises ValueError if processor_name is not a valid processor.
        Returns self for method chaining.
        """
    
    def run(self, text: str) -> str:
        """
        Run all added processors in order on the text.
        Returns the processed text.
        """
    
    def clear(self) -> "Pipeline":
        """Remove all processors. Returns self for chaining."""
    
    def __len__(self) -> int:
        """Return the number of processors in the pipeline."""
```

### Rules

1. Processors must be looked up dynamically from the `processors` module — do NOT hardcode function references.
2. The `add()` method must validate that the name corresponds to a real function in `src/processors.py`.
3. Method chaining must be supported: `Pipeline().add("lowercase").add("strip_whitespace").run(text)`
