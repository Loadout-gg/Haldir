import originalArtwork from '@/assets/haldir/logo-horizontal.png'

/** UI v1: text-only header, incumbent original artwork in agent avatars.
 * The asset is unchanged; the avatar viewport shows its original head mark. */
export function HaldirWordmark() {
  return <span className="haldir-wordmark">Haldir</span>
}
export function HaldirAvatar() {
  return <span className="agent-avatar" aria-hidden="true"><img src={originalArtwork} alt="" width={663} height={204} /></span>
}
