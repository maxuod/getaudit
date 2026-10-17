import type { MessageKey } from './en.ts';

export const loadingPhaseMessages = {
  "entry": [
    "loading.entry.ourLittleHelperIsClearingTheDeskForFreshClues",
    "loading.entry.theNotebookIsOpenAndThePencilIsReadyForClues",
    "loading.entry.weReLayingOutTheMapBeforeFollowingTheFootprints",
    "loading.entry.aFreshPageAClearDeskAndALittleRoomFor",
    "loading.entry.ourHelperIsMakingSpaceForTheLinksOnTheDesk",
    "loading.entry.theMagnifyingGlassIsGettingAFrontRowSeat",
    "loading.entry.weReGivingTheStartingPointsTheirOwnStickyNotes",
    "loading.entry.theDeskLampIsOnAndTheTrailStartsHere",
    "loading.entry.ourHelperIsKeepingTheNotebookOpenForTheNextClue",
    "loading.entry.theTrailMapIsSpreadOutWithPlentyOfRoomIn",
    "loading.entry.ourHelperIsSharpeningThePencilForACloserLook",
    "loading.entry.weReTakingTheLinksOutOfTheDrawerAndOnto"
  ],
  "citations": [
    "loading.citations.ourHelperIsPuttingOnTheTinyReadingGlasses",
    "loading.citations.weReKeepingTheAnswerAndItsSourceOnTheSame",
    "loading.citations.theStickyNotesAreKeepingTheQuotesCompany",
    "loading.citations.ourHelperIsHoldingThePlaceWithAVerySmallBookmark",
    "loading.citations.theMagnifyingGlassIsSpendingSomeTimeWithTheFootnotes",
    "loading.citations.weReLiningUpThePaperTrailBesideTheWords",
    "loading.citations.theReadingLampIsOnDutyForTheFinePrint",
    "loading.citations.ourHelperIsKeepingAFingerOnTheSourcePage",
    "loading.citations.theQuotesHaveASeatTheSourcesHaveTheNeighboringOne",
    "loading.citations.weReMakingRoomInTheMarginsForTheSourceLinks",
    "loading.citations.aBookmarkHereAStickyNoteThereAndACloserLook",
    "loading.citations.ourHelperIsLayingOutTheReferencesForACloserLook"
  ],
  "records": [
    "loading.records.ourHelperIsGivingThePaperworkALittleElbowRoom",
    "loading.records.weReKeepingThePaperTrailBesideTheNotesAsWe",
    "loading.records.theFilingTrayIsOpenForBusiness",
    "loading.records.ourHelperIsLiningUpTheFoldersOnTheDesk",
    "loading.records.weReGivingEachNoteASpotInTheNotebook",
    "loading.records.theStickyNotesAreReportingForFilingDuty",
    "loading.records.ourHelperIsStraighteningTheStackOnePageAtATime",
    "loading.records.weReKeepingTheLinksBesideTheNotesTheyCameWith",
    "loading.records.aPlaceForThePagesALittleSpaceForTheMargins",
    "loading.records.thePaperClipsAreTakingTheirDeskJobSeriously",
    "loading.records.ourHelperIsSortingTheDeskWithTheSourceLabelsIn",
    "loading.records.theFoldersAreOpenAndTheNotesAreSettlingIntoPlace"
  ]
} as const satisfies Record<'entry' | 'citations' | 'records', readonly MessageKey[]>;

export const loadingStateMessages = {
  "waiting": [
    "loading.waiting.ourHelperHasSetThePencilDownForAMoment",
    "loading.waiting.theDeskIsOnPauseTheNotebookIsStayingOpen",
    "loading.waiting.theReadingGlassesAreRestingBesideTheNotes"
  ],
  "blocked": [
    "loading.blocked.thereSAClosedDoorOnThisPaperTrail",
    "loading.blocked.ourHelperHasPutAStickyNoteOnTheSnag",
    "loading.blocked.thePencilIsParkedUntilThisKnotIsUntangled"
  ],
  "complete": [
    "loading.complete.theDeskIsTidyAndThisRoundOfPaperworkCanRest",
    "loading.complete.ourHelperIsPuttingThePencilBackInItsCup",
    "loading.complete.theNotebookCanTakeABreatherThisTaskIsComplete"
  ]
} as const satisfies Record<string, readonly MessageKey[]>;
