const records = Array.from({ length: 2_000 }, (_, id) => ({
  id,
  active: id % 3 === 0,
  name: `streamdrop-${id}`,
  values: [id, id + 1, id + 2, id + 3],
}))
const json = JSON.stringify(records)

const started = Bun.nanoseconds()
let checksum = 0
for (let iteration = 0; iteration < 500; iteration++) {
  const parsed = JSON.parse(json) as typeof records
  checksum += parsed[iteration % parsed.length]!.values[2]!
  checksum += JSON.stringify(parsed).length
}
const elapsedMs = (Bun.nanoseconds() - started) / 1e6

console.log(JSON.stringify({ elapsedMs, checksum }))

