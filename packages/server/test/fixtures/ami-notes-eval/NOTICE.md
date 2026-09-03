# AMI Meeting Corpus excerpts

The `.json` files beside this notice hold transcript excerpts from the **AMI
Meeting Corpus**, used by `bun run notes:eval` to run the meeting note-taker
over real speech.

- Source: https://groups.inf.ed.ac.uk/ami/corpus/
- Licence: **Creative Commons Attribution 4.0 International (CC BY 4.0)** —
  https://creativecommons.org/licenses/by/4.0/
- Taken from the manual annotations release `ami_public_manual_1.6.2`, word
  files `words/<meeting>.<speaker>.words.xml`.

Each file names the meeting and the window of it that was cut. Speakers are
the corpus's own single letters (A, B, C, D); no excerpt names a person.

Regenerate with `bun run notes:eval:fixtures` after downloading the
annotations once:

```
curl -o ~/Library/Caches/claude-workspaces/ami/ami_public_manual_1.6.2.zip \
  https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip
```

The `board` field in each file is NOT from the corpus. It is a small set of
board rows written for the eval, naming the subjects of the AMI scenario
brief (four people designing a television remote control), so that "did the
note-taker link the row that was named" has examples to measure.
