import './About.scss'

const STAGES = [
  {
    label: 'Stage 1 & 1a',
    region: 'Europe & Central Asia',
    route: 'Praia do Guincho → Baku → Bishkek',
    detail: 'From the Atlantic coast of Portugal, east across the Iberian Peninsula, through the Balkans, Turkey, the Caucasus, and deep into the steppes of Kazakhstan and Kyrgyzstan.',
  },
  {
    label: 'Stage 2',
    region: 'Australia',
    route: 'Perth → Sydney',
    detail: 'A crossing of the Australian continent, west to east, through the Nullarbor Plain and along the southern coast before climbing into New South Wales.',
  },
  {
    label: 'Stage 3',
    region: 'South America',
    route: 'Manta → Rio de Janeiro',
    detail: 'Beginning on the Pacific coast of Ecuador, south through Peru and Bolivia, crossing the Andes and descending into Brazil to finish on the shores of Rio de Janeiro.',
  },
  {
    label: 'Stage 4',
    region: 'Africa',
    route: 'West Africa → Nyali Beach, Mombasa',
    detail: 'A traverse of the African continent, moving east across the Sahel and equatorial regions, finishing on the Indian Ocean coast of Kenya.',
  },
  {
    label: 'Stage 5',
    region: 'Asia',
    route: 'Mumbai → Wenzhou',
    detail: 'From the west coast of India, northeast through the subcontinent, across the Himalayas and into China, finishing on the Pacific coast.',
  },
  {
    label: 'Stage 6',
    region: 'North America',
    route: 'Santa Monica → New York',
    detail: 'Coast to coast across the United States, from the Pacific shore at Santa Monica Pier to the East River in New York City.',
  },
  {
    label: 'Stage 7',
    region: 'Antarctica',
    route: 'Antarctic traverse',
    detail: 'The final and most extreme stage — a human-powered crossing of Antarctica, completing the seven-continent journey.',
  },
]

export default function About() {
  return (
    <div className="about">
      <div className="about-content">
        <section className="about-hero">
          <p className="about-overline">The Expedition</p>
          <h1>Seven continents.<br />Human power only.</h1>
          <p className="about-lead">
            Project 7 is an attempt to become the first person to complete a
            human-powered journey across all seven continents — cycling, rowing,
            and trekking every kilometre without the aid of a motor.
          </p>
        </section>

        <section className="about-section">
          <h2>The Mission</h2>
          <p>
            The concept is simple: visit every continent and cross each one
            entirely under human power. No motors, no sails, no shortcuts.
            The route was designed to maximise geographic coverage while
            remaining logistically possible — crossing oceans by rowing or
            paddling, and covering land by bicycle or on foot.
          </p>
          <p>
            The journey spans roughly 50,000 km across seven continents and
            multiple ocean crossings. Each stage presents its own set of
            challenges: heat and distance in Australia, altitude in the Andes,
            extreme cold in Antarctica.
          </p>
        </section>

        <section className="about-section">
          <h2>The Route</h2>
          <div className="about-stages">
            {STAGES.map((s) => (
              <div key={s.label} className="about-stage">
                <div className="about-stage-header">
                  <span className="about-stage-label">{s.label}</span>
                  <span className="about-stage-region">{s.region}</span>
                </div>
                <p className="about-stage-route">{s.route}</p>
                <p className="about-stage-detail">{s.detail}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
