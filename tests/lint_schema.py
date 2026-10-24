"""Static checks for supabase/schema.sql (no Postgres available offline): re-runnable, ordered, balanced."""
import re,sys,os
sql=open(sys.argv[1] if len(sys.argv)>1 else os.path.join(os.path.dirname(__file__),'..','supabase','schema.sql'),encoding='utf-8').read()
bad=[]
def err(m):bad.append(m)
if sql.count('$$')%2:err('unbalanced $$')
# split statements outside $$ blocks / line comments
stmts=[];cur='';inb=False
for line in sql.split('\n'):
    code=re.sub(r'--.*$','',line) if not inb else line
    cur+=code+'\n'
    if code.count('$$')%2:inb=not inb
    if not inb and code.rstrip().endswith(';'):stmts.append(cur.strip());cur=''
if cur.strip():err('last statement not terminated with ;: '+cur.strip()[:60])
created_tables=set();created_funcs=set()
for st in stmts:
    one=' '.join(st.split()).lower()
    for pat,name in ((r'^create table public\.','create table without IF NOT EXISTS'),(r'^create function','create function without OR REPLACE'),(r'^create view','create view without OR REPLACE'),(r'^create index on','unnamed index'),(r'^create type','create type outside DO block')):
        if re.match(pat,one):err(f'{name}: {st[:70]}')
    if one.startswith('create trigger'):
        n=re.match(r'create trigger (\w+)',one).group(1)
        if f'drop trigger if exists {n}' not in sql.lower():err('trigger not dropped first: '+n)
    if one.startswith('create policy'):
        n=re.match(r'create policy (\w+) on ([\w\.]+)',one);
        if f'drop policy if exists {n.group(1)} on {n.group(2)}' not in sql.lower():err('policy not dropped first: '+n.group(1))
    m=re.match(r'create table if not exists public\.(\w+)',one)
    if m:
        for ref in re.findall(r'references (?:public\.)?(\w+)\(',one):
            if ref not in created_tables and ref!='users':err(f'{m.group(1)} references {ref} before it is created')
        created_tables.add(m.group(1))
    m=re.match(r'create or replace function public\.(\w+)',one)
    if m:
        created_funcs.add(m.group(1))
        if one.startswith('create or replace function') and ' language sql' in one:       # SQL function bodies are validated at creation
            for t in re.findall(r'(?:from|into) (?:public\.)?(\w+)',one.split('$$',1)[1] if '$$' in one else ''):
                if t not in created_tables and t not in ('users','auth'):err(f'sql function {m.group(1)} uses table {t} before it exists')
    if one.startswith('drop policy if exists') or one.startswith('create policy'):
        for fn in re.findall(r'(\w+)\(\)',one):
            if fn in ('is_faculty','my_roll') and fn not in created_funcs:err(f'policy uses {fn}() before it is defined')
    if re.match(r'^(grant|revoke) ',one) and 'on function' in one:
        for fn in re.findall(r'public\.(\w+)',one):
            if fn not in created_funcs:err(f'grant/revoke on undefined function {fn}')
    if re.match(r'^alter table public\.(\w+) enable row level security',one):
        t=re.match(r'^alter table public\.(\w+)',one).group(1)
        if t not in created_tables:err('RLS on missing table '+t)
for t in ('students','certificates','notifications','audit_logs','sync_reports','settings','profiles','faculty_emails','removed_keys','requirements','student_auth','student_sessions','google_connection','reminder_log'):
    if not re.search(rf'alter table public\.{t} enable row level security',sql):err('RLS not enabled on '+t)
if 'where true on conflict' not in sql:err('backfill INSERT…SELECT…ON CONFLICT needs WHERE true')
print('schema.sql: %d statements, %d tables, %d functions'%(len(stmts),len(created_tables),len(created_funcs)))
print('LINT OK' if not bad else 'LINT FAILED:\n  '+'\n  '.join(bad));sys.exit(1 if bad else 0)
