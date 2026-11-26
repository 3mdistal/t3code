set -u
CAT="apps/web/src/i18n/translations apps/mobile/src/i18n/translations apps/desktop/src/i18n/translations"
for a in web mobile desktop; do
  if (cd apps/$a && vp run i18n:generate) > /tmp/gen-$a.log 2>&1; then echo "generated $a"; else echo "generate $a FAILED"; tail -40 /tmp/gen-$a.log; fi
done
git diff --stat -- $CAT
node .sync-scratch/fill.mjs
if vp fmt $CAT > /tmp/fmt.log 2>&1; then echo "formatted"; else echo "fmt FAILED"; tail -20 /tmp/fmt.log; fi
vp run i18n:check 2>&1 | tail -20
git status --short
git diff --stat -- $CAT
echo "=====CATALOG-DIFF-BEGIN====="
git diff -- $CAT | gzip -9 | base64 -w0
echo
echo "=====CATALOG-DIFF-END====="
(cd apps/server && vp test run src/provider/AgentContextBudget.test.ts) 2>&1 | grep -v '^\s*$' | tail -60
