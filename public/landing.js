/* =========================
   TEACHERS SLIDER
========================= */

const teacherGrid = document.getElementById("teacherGrid");
const teachersPrev = document.getElementById("teachersPrev");
const teachersNext = document.getElementById("teachersNext");

if (teacherGrid && teachersPrev && teachersNext) {

    const teachers = document.querySelectorAll(".teacher-card");

    let currentTeacher = 0;


    function getVisibleTeachers() {

        if (window.innerWidth <= 600) {
            return 1;
        }

        if (window.innerWidth <= 900) {
            return 2;
        }

        return 3;
    }


    function getMaxPosition() {

        return Math.max(
            0,
            teachers.length - getVisibleTeachers()
        );
    }


    function updateSlider() {

        const visible = getVisibleTeachers();

        const gap = 18;

        const cardWidth =
            teachers[0].offsetWidth;

        const move =
            currentTeacher * (cardWidth + gap);

        teacherGrid.style.transform =
            `translateX(-${move}px)`;


        teachersPrev.disabled =
            currentTeacher === 0;

        teachersNext.disabled =
            currentTeacher >= getMaxPosition();
    }


    teachersNext.addEventListener("click", function () {

        if (currentTeacher < getMaxPosition()) {

            currentTeacher++;

            updateSlider();
        }

    });


    teachersPrev.addEventListener("click", function () {

        if (currentTeacher > 0) {

            currentTeacher--;

            updateSlider();
        }

    });


    window.addEventListener("resize", function () {

        currentTeacher =
            Math.min(
                currentTeacher,
                getMaxPosition()
            );

        updateSlider();

    });


    updateSlider();

}