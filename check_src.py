import io
s = io.open('src/main.ts', encoding='utf-8').read()
probes = [
    'Migrate the legacy shared mapping into per-type mappings',
    'delete rawData.mapping',
    'rawData.serialMapping',
    'rawData.filmMapping',
]
for p in probes:
    print(p, '->', p in s)
print('serialPosterDir default ->', 'serialPosterDir = "TV_series_posters"' in s)
print('mappingForType ->', 'mappingForType' in s)
print('enrichedMarkerProperty(t: NoteType) ->', 'enrichedMarkerProperty(t: NoteType): string' in s)
